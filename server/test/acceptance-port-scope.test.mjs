import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftPorts } from '../../scripts/acceptance/acceptance-lib.mjs';
import { ITEMS } from '../../scripts/acceptance/four-stage-manifest.mjs';

const item = (id) => {
  const found = ITEMS.find((entry) => entry.id === id);
  assert.ok(found, `manifest item ${id} exists`);
  return found.cmd;
};

test('port shifting preserves the self-reserved ranges used by both real probe manifest commands', () => {
  const multiAgent = item('P-multi-agent');
  assert.equal(multiAgent.includes('scripts/probes/multi-agent-probe.mjs'), true);
  assert.deepEqual(shiftPorts(multiAgent, 210), multiAgent, 'multi-agent uses its own fixed 5840–5859 defaults');
  assert.deepEqual(shiftPorts([...multiAgent, '--port', '5840'], 210), [...multiAgent, '--port', '5840'],
    'an explicit self-range argument on this probe remains in its allowed segment');

  const skillMcp = item('P-skill-mcp');
  assert.equal(skillMcp.includes('scripts/probes/skill-mcp-probe.mjs'), true);
  assert.deepEqual(skillMcp.slice(0, 4), ['node', 'scripts/probes/skill-mcp-probe.mjs', '--port', '5880']);
  assert.deepEqual(shiftPorts(skillMcp, 210), skillMcp, 'the manifest command keeps --port 5880 and its arguments');
  assert.equal(shiftPorts(skillMcp, 210)[skillMcp.indexOf('5880')], '5880');
});

test('port shifting still moves ordinary 5xxx flags while preserving 8xxx services and non-port values', () => {
  assert.deepEqual(shiftPorts(['node', 'ordinary.mjs', '--port', '5690', '--base-port', '5860', '--doc-port', '8760', '--iters', '5690'], 210),
    ['node', 'ordinary.mjs', '--port', '5900', '--base-port', '6070', '--doc-port', '8760', '--iters', '5690']);
  assert.deepEqual(shiftPorts(['node', 'scripts/probes/skill-mcp-probe.mjs', '--port', '5880', '--online-base', '5690'], 210),
    ['node', 'scripts/probes/skill-mcp-probe.mjs', '--port', '5880', '--online-base', '5900']);
});
