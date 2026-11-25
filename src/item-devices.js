'use strict';
// The devices an item can need (Alex, 2026-11-25), matching DEVICE-SETUP.md's Devices table. Blank = the VPS or Alex's
// phone can do it. Session starts on a device pull only their own items. (Not src/devices.js: that's device enrollment.)
module.exports = { DEVICES: ['mac', 'adaone', 'adatwo'] };
