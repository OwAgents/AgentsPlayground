// Node 20 does not expose File globally, while the 9Router/Next runtime
// expects the Web API global when handling provider requests.
if (typeof globalThis.File === 'undefined') {
  globalThis.File = require('buffer').File;
}
