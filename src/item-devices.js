'use strict';
// The devices an item can need (Alex, 2026-11-25), matching DEVICE-SETUP.md's Devices table. Blank = the VPS or Alex's
// phone can do it. Session starts on a device pull only their own items. (Not src/devices.js: that's device enrollment.)
const DEVICES = ['mac', 'adaone', 'adatwo'];

// A task can list several computers in `devices` (2+; the first to start it claims it, todo-cli.js claim). Then `device`
// is null. This is every device a task could run on: [] = the VPS or Alex's phone.
const taskDevices = (t) => (t && Array.isArray(t.devices) && t.devices.length ? t.devices : t && t.device ? [t.device] : []);

module.exports = { DEVICES, taskDevices };
