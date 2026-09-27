// Child-process-only build guard. Never preload this in a running application.
const deny = () => { throw new Error('OFFLINE_BUILD_NETWORK_DISABLED'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
require('node:http').request = deny;
require('node:http').get = deny;
require('node:https').request = deny;
require('node:https').get = deny;
globalThis.fetch = deny;
require('node:module').syncBuiltinESMExports();
