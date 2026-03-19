import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { initConfig, initDir } from "./utils";
import { createServer } from "./server";
import { apiKeyAuth } from "./middleware/auth";
import { CONFIG_FILE, HOME_DIR, listPresets } from "@CCR/shared";
import { createStream } from 'rotating-file-stream';
import { sessionUsageCache } from "@musistudio/llms";
import { SSEParserTransform } from "./utils/SSEParser.transform";
import { SSESerializerTransform } from "./utils/SSESerializer.transform";
import { rewriteStream } from "./utils/rewriteStream";
import JSON5 from "json5";
import { IAgent, ITool } from "./agents/type";
import agentsManager from "./agents";
import { detectImages, stripImages } from "./agents/imageDetection";
import { NsfwVisionService } from "./sanitizer/vision";
import { activateImageAgentForSfw, handleNsfwImages } from "./sanitizer/imageRouting";
import { EventEmitter } from "node:events";
import { pluginManager, tokenSpeedPlugin } from "@musistudio/llms";
import { Switcher, createSwitcherHook } from "./switcher";
import { Sanitizer, createSanitizerHook } from "./sanitizer";
import { PipelineStore } from "./sanitizer/store";
import { ReportAccumulator } from "./sanitizer/report";
import { NsfwFillService } from "./sanitizer/fill";
import { ApplyService } from "./sanitizer/apply";
import { scanProjectPlaceholders, buildSyntheticReport } from "./sanitizer/scan";
import { ResponseAccumulator } from "./utils/ResponseAccumulator";

const event = new EventEmitter()

async function initializeClaudeConfig() {
  const homeDir = homedir();
  const configPath = join(homeDir, ".claude.json");
  if (!existsSync(configPath)) {
    const userID = Array.from(
      { length: 64 },
      () => Math.random().toString(16)[2]
    ).join("");
    const configContent = {
      numStartups: 184,
      autoUpdaterStatus: "enabled",
      userID,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "1.0.17",
      projects: {},
    };
    await writeFile(configPath, JSON.stringify(configContent, null, 2));
  }
}

interface RunOptions {
  port?: number;
  logger?: any;
}

/**
 * Plugin configuration from config file
 */
interface PluginConfig {
  name: string;
  enabled?: boolean;
  options?: Record<string, any>;
}

/**
 * Register plugins from configuration
 * @param serverInstance Server instance
 * @param config Application configuration
 */
async function registerPluginsFromConfig(serverInstance: any, config: any): Promise<void> {
  // Get plugins configuration from config file
  const pluginsConfig: PluginConfig[] = config.plugins || config.Plugins || [];

  for (const pluginConfig of pluginsConfig) {
      const { name, enabled = false, options = {} } = pluginConfig;

      switch (name) {
        case 'token-speed':
          pluginManager.registerPlugin(tokenSpeedPlugin, {
            enabled,
            outputHandlers: [
              {
                type: 'temp-file',
                enabled: true
              }
            ],
            ...options
          });
          break;

        default:
          console.warn(`Unknown plugin: ${name}`);
          break;
      }
    }
  // Enable all registered plugins
  await pluginManager.enablePlugins(serverInstance);
}

async function getServer(options: RunOptions = {}) {
  await initializeClaudeConfig();
  await initDir();
  const config = await initConfig();

  // Check if Providers is configured
  const providers = config.Providers || config.providers || [];
  const hasProviders = providers && providers.length > 0;

  let HOST = config.HOST || "127.0.0.1";

  if (hasProviders) {
    HOST = config.HOST;
    if (!config.APIKEY) {
      HOST = "127.0.0.1";
    }
  } else {
    // When no providers are configured, listen on 0.0.0.0 without authentication
    HOST = "0.0.0.0";
    console.log("ℹ️  No providers configured. Listening on 0.0.0.0 without authentication.");
  }

  const port = config.PORT || 3456;

  // Use port from environment variable if set (for background process)
  const servicePort = process.env.SERVICE_PORT
    ? parseInt(process.env.SERVICE_PORT)
    : port;

  // Configure logger based on config settings or external options
  const pad = (num: number) => (num > 9 ? "" : "0") + num;
  const generator = (time: number | Date | undefined, index: number | undefined) => {
    let date: Date;
    if (!time) {
      date = new Date();
    } else if (typeof time === 'number') {
      date = new Date(time);
    } else {
      date = time;
    }

    const month = date.getFullYear() + "" + pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());

    return `./logs/ccr-${month}${day}${hour}${minute}${pad(date.getSeconds())}${index ? `_${index}` : ''}.log`;
  };

  let loggerConfig: any;

  // Use external logger configuration if provided
  if (options.logger !== undefined) {
    loggerConfig = options.logger;
  } else {
    // Enable logger if not provided and config.LOG !== false
    if (config.LOG !== false) {
      // Set config.LOG to true (if not already set)
      if (config.LOG === undefined) {
        config.LOG = true;
      }
      loggerConfig = {
        level: config.LOG_LEVEL || "debug",
        stream: createStream(generator, {
          path: HOME_DIR,
          maxFiles: 3,
          interval: "1d",
          compress: false,
          maxSize: "50M"
        }),
      };
    } else {
      loggerConfig = false;
    }
  }

  const presets = await listPresets();

  const serverInstance = await createServer({
    jsonPath: CONFIG_FILE,
    initialConfig: {
      // ...config,
      providers: config.Providers || config.providers,
      HOST: HOST,
      PORT: servicePort,
      LOG_FILE: join(
        homedir(),
        ".claude-code-router",
        "claude-code-router.log"
      ),
    },
    logger: loggerConfig,
  });

  await Promise.allSettled(
      presets.map(async preset => await serverInstance.registerNamespace(`/preset/${preset.name}`, preset.config))
  )

  // Register and configure plugins from config
  await registerPluginsFromConfig(serverInstance, config);

  // Add async preHandler hook for authentication
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    return new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };
      // Call the async auth function
      apiKeyAuth(config)(req, reply, done).catch(reject);
    });
  });
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    const url = new URL(`http://127.0.0.1${req.url}`);
    req.pathname = url.pathname;
    if (req.pathname.endsWith("/v1/messages") && req.pathname !== "/v1/messages") {
      req.preset = req.pathname.replace("/v1/messages", "").replace("/", "");
    }
  })

  // Extract sessionId from metadata early so it is available in all preHandler hooks
  serverInstance.addHook("preHandler", async (req: any) => {
    if (req.body?.metadata?.user_id && !req.sessionId) {
      const userId = req.body.metadata.user_id

      // Format 1: JSON string with session_id field
      // e.g. '{"device_id":"...","session_id":"f3c0aad7-..."}'
      if (userId.startsWith("{")) {
        try {
          const parsed = JSON.parse(userId)
          if (parsed.session_id) {
            req.sessionId = parsed.session_id
          }
        } catch {
          // Not valid JSON, try other formats
        }
      }

      // Format 2: Legacy "prefix_session_<id>" string
      if (!req.sessionId) {
        const parts = userId.split("_session_")
        if (parts.length > 1) {
          req.sessionId = parts[1]
        }
      }
    }
  })

  // Strip thinking blocks from previous messages to avoid invalid signature errors
  // when routing through different providers/proxies
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    if (req.pathname.endsWith("/v1/messages") && Array.isArray(req.body?.messages)) {
      req.body = {
        ...req.body,
        messages: req.body.messages.map((msg: any) => {
          if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
            return msg
          }
          const filtered = msg.content.filter(
            (block: any) => block.type !== "thinking" && block.type !== "redacted_thinking"
          )
          if (filtered.length === msg.content.length) {
            return msg
          }
          return { ...msg, content: filtered }
        })
      }
    }
  })

  // Image detection: detect and store metadata only, do NOT activate ImageAgent yet.
  // The decision to activate ImageAgent or use NsfwVisionService happens after classification.
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    if (req.pathname?.endsWith("/v1/messages") && Array.isArray(req.body?.messages)) {
      const detection = detectImages(req.body.messages)
      if (detection.hasImages) {
        req.detectedImages = detection
      }
    }
  });

  // Pipeline mode: Sanitizer replaces Switcher (does classification + decomposition)
  // Legacy mode: Switcher does classification only
  const pipelineConfig = config.Pipeline || {}
  const switcherConfig = config.Switcher || {}
  const sanitizer = new Sanitizer(
    pipelineConfig,
    serverInstance.app.log,
    switcherConfig.classifierApiKey
  )

  const pipelineStore = sanitizer.isEnabled
    ? new PipelineStore(
        sanitizer.config.sfwAgent.storeMaxSize,
        sanitizer.config.sfwAgent.storeTtlMs,
        serverInstance.app.log
      )
    : null

  const fillService = sanitizer.isEnabled
    ? new NsfwFillService(sanitizer.config.nsfwAgent, serverInstance.app.log)
    : null

  const applyService = sanitizer.isEnabled
    ? new ApplyService(sanitizer.config.apply, serverInstance.app.log)
    : null

  const visionConfig = sanitizer.isEnabled ? sanitizer.config.nsfwVision : undefined
  const nsfwVisionService = visionConfig?.model
    ? new NsfwVisionService(visionConfig, serverInstance.app.log)
    : null

  if (sanitizer.isEnabled) {
    serverInstance.addHook("preHandler", createSanitizerHook(sanitizer, pipelineStore, serverInstance.app.log))
  } else {
    const switcher = new Switcher(switcherConfig, serverInstance.app.log)
    if (switcher.isEnabled) {
      serverInstance.addHook("preHandler", createSwitcherHook(switcher))
    }
  }

  // Post-classification image routing: decide SFW (ImageAgent) vs NSFW (vision descriptions) path
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    if (!req.detectedImages || !req.pathname?.endsWith("/v1/messages")) return

    const isNsfwPipeline = !!req.sanitizerResult

    if (isNsfwPipeline) {
      // NSFW path: describe images via uncensored vision model, strip image blocks
      await handleNsfwImages(req, req.detectedImages, nsfwVisionService, pipelineStore, serverInstance.app.log, req.pipelineApiKey)
    } else if (req.switcherResult?.classification === "nsfw") {
      // NSFW without cleanPrompt (parse failure): strip images for text-only model
      req.body = { ...req.body, messages: stripImages(req.body.messages) }
    } else {
      // SFW path: activate ImageAgent as before
      activateImageAgentForSfw(req, config, req.detectedImages)
    }
  })

  // Non-image agent detection: run all agents except ImageAgent (handled above)
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    if (req.pathname?.endsWith("/v1/messages")) {
      const useAgents: string[] = []

      for (const agent of agentsManager.getAllAgents()) {
        if (agent.name === "image") continue

        if (agent.shouldHandle(req, config)) {
          useAgents.push(agent.name)
          agent.reqHandler(req, config)

          if (agent.tools.size) {
            if (!req.body?.tools?.length) {
              req.body = { ...req.body, tools: [] }
            }
            req.body = {
              ...req.body,
              tools: [
                ...Array.from(agent.tools.values()).map(item => ({
                  name: item.name,
                  description: item.description,
                  input_schema: item.input_schema,
                })),
                ...req.body.tools,
              ],
            }
          }
        }
      }

      if (useAgents.length) {
        req.agents = req.agents ? [...req.agents, ...useAgents] : useAgents
      }
    }
  })

  serverInstance.addHook("onError", async (request: any, reply: any, error: any) => {
    event.emit('onError', request, reply, error);
  })
  serverInstance.addHook("onSend", (req: any, reply: any, payload: any, done: any) => {
    const relation_id = { reqId: req.id, sessionId: req.sessionId || null }

    if (req.sessionId && req.pathname.endsWith("/v1/messages")) {
      if (payload instanceof ReadableStream) {
        const [processingStream, loggingStream] = payload.tee()
        new ResponseAccumulator().accumulate(loggingStream).then(
          (response) => {
            serverInstance.app.log.debug(
              { relation_id, response, type: "assembled_response" },
              "Response complete"
            )
          }
        ).catch(() => {})

        // Pipeline: extract implementation report from streaming response
        // Also trigger when an active NSFW session exists (final response may classify as SFW
        // because the conversation grew long and the truncated window is all code)
        const activeSession = pipelineStore?.getSession(req.sessionId)
        const shouldExtractReport = !req.agents && pipelineStore && (
          req.sanitizerResult ||
          (activeSession && activeSession.status === "sfw_in_progress")
        )
        if (shouldExtractReport) {
          const [originalStream, extractionStream] = processingStream.tee()

          const accumulator = new ReportAccumulator(sanitizer.config.sfwAgent)
          const extractReport = async (stream: ReadableStream) => {
            // Decode binary stream to text before SSE parsing
            const textStream = stream.pipeThrough(new TextDecoderStream())
            const parsed = textStream.pipeThrough(new SSEParserTransform())
            const reader = parsed.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (
                  value?.data?.delta?.type === "text_delta" &&
                  typeof value.data.delta.text === "string"
                ) {
                  const report = accumulator.addChunk(value.data.delta.text)
                  if (report && req.sessionId) {
                    pipelineStore.setReport(req.sessionId, report)
                    // Auto-trigger with skipBuild — the platform's health check
                    // will verify the result via HMR, no need for npm run build
                    event.emit('pipeline:reportCaptured', req.sessionId, { skipBuild: true })
                    break
                  }
                }
                if (value?.event === "message_delta" && value?.data?.usage) {
                  sessionUsageCache.put(req.sessionId, value.data.usage)
                }
              }
            } catch (err: any) {
              if (err.name !== "AbortError" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                serverInstance.app.log.error(
                  { relation_id, error: err.message },
                  "Pipeline: report extraction error"
                )
              }
            } finally {
              reader.releaseLock()
            }
          }
          extractReport(extractionStream).catch((err: any) => {
            serverInstance.app.log.error(
              { relation_id, error: err.message },
              "Pipeline: unexpected report extraction error"
            )
          })
          return done(null, originalStream)
        }

        if (req.agents) {
          const abortController = new AbortController();
          const eventStream = processingStream.pipeThrough(new SSEParserTransform())
          let currentAgent: undefined | IAgent;
          let currentToolIndex = -1
          let currentToolName = ''
          let currentToolArgs = ''
          let currentToolId = ''
          const toolMessages: any[] = []
          const assistantMessages: any[] = []
          // Store Anthropic format message body, distinguishing text and tool types
          return done(null, rewriteStream(eventStream, async (data, controller) => {
            try {
              // Detect tool call start
              if (data.event === 'content_block_start' && data?.data?.content_block?.name) {
                const agent = req.agents.find((name: string) => agentsManager.getAgent(name)?.tools.get(data.data.content_block.name))
                if (agent) {
                  currentAgent = agentsManager.getAgent(agent)
                  currentToolIndex = data.data.index
                  currentToolName = data.data.content_block.name
                  currentToolId = data.data.content_block.id
                  return undefined;
                }
              }

              // Collect tool arguments
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data?.delta?.type === 'input_json_delta') {
                currentToolArgs += data.data?.delta?.partial_json;
                return undefined;
              }

              // Tool call completed, handle agent invocation
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data.type === 'content_block_stop') {
                try {
                  const args = JSON5.parse(currentToolArgs);
                  assistantMessages.push({
                    type: "tool_use",
                    id: currentToolId,
                    name: currentToolName,
                    input: args
                  })
                  const toolResult = await currentAgent?.tools.get(currentToolName)?.handler(args, {
                    req,
                    config
                  });
                  toolMessages.push({
                    "tool_use_id": currentToolId,
                    "type": "tool_result",
                    "content": toolResult
                  })
                  currentAgent = undefined
                  currentToolIndex = -1
                  currentToolName = ''
                  currentToolArgs = ''
                  currentToolId = ''
                } catch (e) {
                  console.log(e);
                }
                return undefined;
              }

              if (data.event === 'message_delta' && toolMessages.length) {
                req.body.messages.push({
                  role: 'assistant',
                  content: assistantMessages
                })
                req.body.messages.push({
                  role: 'user',
                  content: toolMessages
                })
                const response = await fetch(`http://127.0.0.1:${config.PORT || 3456}/v1/messages`, {
                  method: "POST",
                  headers: {
                    'x-api-key': config.APIKEY,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify(req.body),
                })
                if (!response.ok) {
                  return undefined;
                }
                const stream = response.body!.pipeThrough(new SSEParserTransform() as any)
                const reader = stream.getReader()
                while (true) {
                  try {
                    const {value, done} = await reader.read();
                    if (done) {
                      break;
                    }
                    const eventData = value as any;
                    if (['message_start', 'message_stop'].includes(eventData.event)) {
                      continue
                    }

                    // Check if stream is still writable
                    if (!controller.desiredSize) {
                      break;
                    }

                    controller.enqueue(eventData)
                  }catch (readError: any) {
                    if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                      abortController.abort(); // Abort all related operations
                      break;
                    }
                    throw readError;
                  }

                }
                return undefined
              }
              return data
            }catch (error: any) {
              console.error('Unexpected error in stream processing:', error);

              // Handle premature stream closure error
              if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                abortController.abort();
                return undefined;
              }

              // Re-throw other errors
              throw error;
            }
          }).pipeThrough(new SSESerializerTransform()))
        }

        const [originalStream, clonedStream] = processingStream.tee();
        const read = async (stream: ReadableStream) => {
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              // Process the value if needed
              const dataStr = new TextDecoder().decode(value);
              if (!dataStr.startsWith("event: message_delta")) {
                continue;
              }
              const str = dataStr.slice(27);
              try {
                const message = JSON.parse(str);
                sessionUsageCache.put(req.sessionId, message.usage);
              } catch {}
            }
          } catch (readError: any) {
            if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
              console.error('Background read stream closed prematurely');
            } else {
              console.error('Error in background stream reading:', readError);
            }
          } finally {
            reader.releaseLock();
          }
        }
        read(clonedStream);
        return done(null, originalStream)
      }
      serverInstance.app.log.debug(
        { relation_id, response: payload, type: "assembled_response" },
        "Response complete"
      )
      sessionUsageCache.put(req.sessionId, payload.usage);
      if (typeof payload ==='object') {
        if (payload.error) {
          return done(payload.error, null)
        } else {
          return done(payload, null)
        }
      }
    }
    if (typeof payload ==='object' && payload.error) {
      return done(payload.error, null)
    }
    done(null, payload)
  });
  serverInstance.addHook("onSend", async (req: any, reply: any, payload: any) => {
    event.emit('onSend', req, reply, payload);
    return payload;
  });

  // Add global error handlers to prevent the service from crashing
  process.on("uncaughtException", (err) => {
    serverInstance.app.log.error("Uncaught exception:", err);
  });

  process.on("unhandledRejection", (reason, promise) => {
    serverInstance.app.log.error("Unhandled rejection at:", promise, "reason:", reason);
  });

  // Pipeline API endpoints
  if (pipelineStore) {
    serverInstance.app.get("/api/pipeline", async () => {
      return { sessions: pipelineStore.listSessions() }
    })

    serverInstance.app.get("/api/pipeline/:sessionId", async (req: any, reply: any) => {
      const state = pipelineStore.getSession(req.params.sessionId)
      if (!state) return reply.status(404).send({ error: "Session not found" })
      return state
    })

    serverInstance.app.post("/api/pipeline/:sessionId/fill", async (req: any, reply: any) => {
      const { sessionId } = req.params
      const state = pipelineStore.getSession(sessionId)
      if (!state) return reply.status(404).send({ error: "Session not found" })
      if (state.status !== "sfw_complete") {
        return reply.status(400).send({
          error: `Status is "${state.status}", need "sfw_complete"`,
        })
      }
      if (!state.nsfwSpec || !state.implementationReport) {
        return reply.status(400).send({ error: "Missing nsfwSpec or implementationReport" })
      }
      if (!fillService) {
        return reply.status(503).send({ error: "NSFW fill service not configured" })
      }

      pipelineStore.setStatus(sessionId, "nsfw_pending")

      const { nsfwSpec, implementationReport } = state

      ;(async () => {
        pipelineStore.setStatus(sessionId, "nsfw_in_progress")
        try {
          const fillResult = await fillService.executeFill(nsfwSpec, implementationReport)
          pipelineStore.setFillResult(sessionId, fillResult)
        } catch (error: any) {
          const errorMsg = error.kind
            ? `[${error.kind}] ${error.message}`
            : error.message
          serverInstance.app.log.error(
            { sessionId, error: errorMsg, kind: error.kind },
            "Pipeline: NSFW fill failed (all retries exhausted)"
          )
          pipelineStore.setStatus(sessionId, "error", errorMsg)
        }
      })()

      return {
        message: "NSFW fill started",
        placeholderCount: implementationReport.placeholders.length,
        status: "nsfw_pending",
        pollUrl: `/api/pipeline/${sessionId}`,
      }
    })

    serverInstance.app.post("/api/pipeline/:sessionId/apply", async (req: any, reply: any) => {
      const { sessionId } = req.params
      const { projectPath } = req.body || {}

      if (!projectPath || typeof projectPath !== "string") {
        return reply.status(400).send({ error: "Missing or invalid projectPath in request body" })
      }

      const state = pipelineStore.getSession(sessionId)
      if (!state) return reply.status(404).send({ error: "Session not found" })
      if (state.status !== "nsfw_complete") {
        return reply.status(400).send({
          error: `Status is "${state.status}", need "nsfw_complete"`,
        })
      }
      if (!state.fillResult) {
        return reply.status(400).send({ error: "Missing fillResult" })
      }
      if (!applyService) {
        return reply.status(503).send({ error: "Apply service not configured" })
      }

      pipelineStore.setStatus(sessionId, "apply_pending")
      const { fillResult } = state

      ;(async () => {
        pipelineStore.setStatus(sessionId, "apply_in_progress")
        try {
          const applyResult = await applyService.executeApply(fillResult, projectPath)
          pipelineStore.setApplyResult(sessionId, applyResult)
        } catch (error: any) {
          const errorMsg = error.kind
            ? `[${error.kind}] ${error.message}`
            : error.message
          serverInstance.app.log.error(
            { sessionId, error: errorMsg, kind: error.kind },
            "Pipeline: apply failed"
          )
          pipelineStore.setStatus(sessionId, "error", errorMsg)
        }
      })()

      return {
        message: "Apply started",
        editCount: fillResult.edits.length,
        contentFileCount: fillResult.contentFiles.length,
        status: "apply_pending",
        pollUrl: `/api/pipeline/${sessionId}`,
      }
    })

    serverInstance.app.post("/api/pipeline/trigger-complete", async (req: any, reply: any) => {
      const { projectPath: filterProjectPath, skipBuild } = req.body || {}

      let sessions = pipelineStore.listSessions()
        .filter((s: any) => s.status === "sfw_in_progress" && s.projectPath)

      if (filterProjectPath && typeof filterProjectPath === "string") {
        sessions = sessions.filter((s: any) => s.projectPath === filterProjectPath)
      }

      if (sessions.length === 0) {
        serverInstance.app.log.info("Pipeline: trigger-complete — no sfw_in_progress sessions")
        return { triggered: 0 }
      }

      const pipelineOptions = skipBuild ? { skipBuild: true } : undefined
      const results: Array<{ sessionId: string; placeholders: number }> = []
      for (const session of sessions) {
        try {
          const scanResults = await scanProjectPlaceholders(session.projectPath!)
          if (scanResults.length === 0) {
            serverInstance.app.log.info(
              { sessionId: session.sessionId, projectPath: session.projectPath },
              "Pipeline: trigger-complete — no placeholders found, skipping"
            )
            continue
          }

          const report = buildSyntheticReport(session.projectPath!, scanResults)
          pipelineStore.setReport(session.sessionId, report)
          serverInstance.app.log.info(
            { sessionId: session.sessionId, placeholderCount: report.placeholders.length },
            "Pipeline: trigger-complete — synthetic report created"
          )
          event.emit("pipeline:reportCaptured", session.sessionId, pipelineOptions)
          results.push({ sessionId: session.sessionId, placeholders: report.placeholders.length })
        } catch (err: any) {
          serverInstance.app.log.error(
            { sessionId: session.sessionId, error: err.message },
            "Pipeline: trigger-complete scan failed"
          )
        }
      }
      return { triggered: results.length, results }
    })
  }

  // Auto-trigger pipeline: fill → apply after report extraction
  if (pipelineStore && fillService && applyService) {
    event.on('pipeline:reportCaptured', async (sessionId: string, options?: { skipBuild?: boolean }) => {
      try {
        const state = pipelineStore.getSession(sessionId)
        if (!state || state.status !== 'sfw_complete') return
        if (!state.nsfwSpec || !state.implementationReport) return

        // Phase 2: NSFW fill (use TK1 from request if available, fallback to config apiKey)
        pipelineStore.setStatus(sessionId, 'nsfw_in_progress')
        const fillResult = await fillService.executeFill(state.nsfwSpec, state.implementationReport, state.requestApiKey)
        pipelineStore.setFillResult(sessionId, fillResult)

        // Phase 3: Resolve projectPath + apply
        let projectPath = state.projectPath
        if (!projectPath) {
          serverInstance.app.log.warn(
            { sessionId },
            'Pipeline: auto-apply skipped — projectPath not captured from request'
          )
          return
        }

        pipelineStore.setStatus(sessionId, 'apply_in_progress')
        const applyResult = await applyService.executeApply(fillResult, projectPath, options)
        pipelineStore.setApplyResult(sessionId, applyResult)
        serverInstance.app.log.info(
          { sessionId, projectPath, skipBuild: !!options?.skipBuild },
          'Pipeline: auto-apply complete'
        )
      } catch (err: any) {
        const errorMsg = err.kind
          ? `[${err.kind}] ${err.message}`
          : err.message
        serverInstance.app.log.error(
          { sessionId, error: errorMsg },
          'Pipeline: auto-trigger failed'
        )
        pipelineStore.setStatus(sessionId, 'error', errorMsg)
      }
    })
  }

  return serverInstance;
}

async function run() {
  const server = await getServer();
  server.app.post("/api/restart", async () => {
    setTimeout(async () => {
      process.exit(0);
    }, 100);

    return { success: true, message: "Service restart initiated" }
  });
  await server.start();
}

export { getServer };
export type { RunOptions };
export type { IAgent, ITool } from "./agents/type";
export { initDir, initConfig, readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
export { pluginManager, tokenSpeedPlugin } from "@musistudio/llms";

// Start service if this file is run directly
if (require.main === module) {
  run().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
