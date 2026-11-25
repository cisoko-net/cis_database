'use strict';
// Test only. Answers synchronously, the way cis_database answers a fast query.
const ROW = { citizenid: 'C0000001', name: 'First Last', money: 500, charinfo: 'x'.repeat(300) };
exports('perCall', (n, cb) => { cb({ n, row: ROW }); });
let registered = null;
exports('register', (fn) => { registered = fn; });
exports('byId', (n, id) => { registered(id, { n, row: ROW }); });
// Returned, no callback at all: what cis_call does for a ready result.
exports('ret', (n) => [1, { n, row: ROW }]);
// Nothing back: the bare cost of an export call.
exports('noop', () => null);
