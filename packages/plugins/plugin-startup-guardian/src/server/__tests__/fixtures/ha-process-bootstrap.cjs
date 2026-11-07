const fs = require('node:fs');

const traceFile = process.env.STARTUP_GUARDIAN_TEST_TRACE_FILE;
if (traceFile) {
  const argv = process.argv.slice(1).map((arg) => arg.replaceAll(process.cwd(), '<cwd>'));
  fs.appendFileSync(
    traceFile,
    `[ha-test-bootstrap pid=${process.pid} deployment=${process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'unknown'} node=${process.env.STARTUP_GUARDIAN_NODE_ID || 'unknown'} boot=${process.env.STARTUP_GUARDIAN_BOOT_ID || 'runner'}] argv=${JSON.stringify(argv)}\n`,
    'utf8',
  );
}
