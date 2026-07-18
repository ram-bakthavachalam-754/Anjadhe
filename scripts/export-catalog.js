#!/usr/bin/env node
/**
 * Export the component catalog (AppSpec.catalog()) to tests/spec/catalog.json —
 * the authoritative, versioned list of components the contract defines. The
 * native iOS engine reads this to know what it must render and at which
 * specVersion, and the conformance runner checks the committed snapshot against
 * the live catalog so it can't drift silently. Run after adding/changing a
 * component: `npm run catalog:export`.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const AppSpec = require(path.join(__dirname, '..', 'js', 'core', 'app-spec.js'));
const out = path.join(__dirname, '..', 'tests', 'spec', 'catalog.json');
fs.writeFileSync(out, JSON.stringify(AppSpec.catalog(), null, 2) + '\n');
console.log(`Wrote ${out} (${AppSpec.catalog().components.length} components, specVersion ${AppSpec.catalog().specVersion}).`);
