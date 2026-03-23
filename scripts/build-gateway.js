#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('Building Gateway package...');

try {
  const gatewayDir = path.join(__dirname, '../packages/gateway');

  // Create dist directory
  const distDir = path.join(gatewayDir, 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // Generate type declaration files
  console.log('Generating type declaration files...');
  execSync('tsc --emitDeclarationOnly', {
    stdio: 'inherit',
    cwd: gatewayDir
  });

  // Build the gateway application
  console.log('Building gateway application...');
  execSync('esbuild src/index.ts --bundle --platform=node --minify --tree-shaking=true --outfile=dist/index.js', {
    stdio: 'inherit',
    cwd: gatewayDir
  });

  console.log('Gateway build completed successfully!');
} catch (error) {
  console.error('Gateway build failed:', error.message);
  process.exit(1);
}
