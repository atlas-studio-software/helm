// Position chats in the shell (ui/shell/position-meta.js): the company chip on the tab and the "reports to" item in
// the session header. Also checks tabs.js / header.js use them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { positionCompany, positionReportsTo } = require('../../ui/shell/position-meta.js');
const SHELL = path.join(__dirname, '..', '..', 'ui', 'shell');

const pos = (over) => ({ id: 's-' + Math.random(), position: { company: 'example-co', companyName: 'Example Co', id: 'cto', name: 'CTO', parent: null, chat: 1, ...over } });

test('positionCompany: the company name, its id when unnamed, null for any other session', () => {
  assert.equal(positionCompany(pos()), 'Example Co');
  assert.equal(positionCompany(pos({ companyName: '' })), 'example-co');
  assert.equal(positionCompany({ id: 'x' }), null);
  assert.equal(positionCompany({ id: 'x', position: null }), null);
  assert.equal(positionCompany({ id: 'x', position: { company: 'c' } }), null);   // no position id: not a position chat
  assert.equal(positionCompany(null), null);
});

test('positionReportsTo: the CEO at top level, the manager by name when its chat is known, else null', () => {
  const lead = pos({ id: 'eng-lead', name: 'Engineering lead', parent: 'cto' });
  const cto = pos();
  const otherCoCto = pos({ company: 'other-co', name: 'Other CTO' });
  assert.equal(positionReportsTo(cto, []), 'the CEO');
  assert.equal(positionReportsTo(lead, [otherCoCto, lead, cto]), 'CTO');
  assert.equal(positionReportsTo(lead, [otherCoCto]), null, 'a manager in another company never matches');
  assert.equal(positionReportsTo(lead, undefined), null);
  assert.equal(positionReportsTo({ id: 'plain' }, [cto]), null);
});

test('tabs.js shows the chip and header.js the reports-to item', () => {
  const tabs = fs.readFileSync(path.join(SHELL, 'tabs.js'), 'utf8');
  assert.match(tabs, /import \{ positionCompany \} from '\.\/position-meta\.js';/);
  assert.match(tabs, /const co = positionCompany\(s\);/);
  assert.match(tabs, /\$\{co && html`<span class="tab-co"/);
  const header = fs.readFileSync(path.join(SHELL, 'header.js'), 'utf8');
  assert.match(header, /const reportsTo = s\.position \? positionReportsTo\(s, sessions\.value\) : null;/);
  assert.match(header, /class="sh-i sh-g sh-reports" data-p="6\.5"/);
  assert.match(fs.readFileSync(path.join(SHELL, 'tabs.css'), 'utf8'), /\.tab-co \{/);
});
