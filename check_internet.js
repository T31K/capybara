#!/usr/bin/env node

import https from 'https';

function checkInternet() {
  return new Promise((resolve) => {
    const req = https.get(
      'https://www.google.com/generate_204',
      { timeout: 5000 },
      (res) => {
        resolve(res.statusCode === 204);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

(async () => {
  const simulateOffline = process.argv.includes('--simulate-offline');

  process.stdout.write('Checking internet connection... ');
  const hasInternet = simulateOffline ? false : await checkInternet();

  if (hasInternet) {
    console.log('\n✓ Internet connection is available.');
  } else {
    console.log('\n✗ No internet connection.');
    process.exit(1);
  }
})();
