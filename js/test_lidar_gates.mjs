// Lidar gates for the browser installer.
//
// The contract these assert:
// fastboot_product LIDAR, hw_profile lidar@1, userdata_sectors 9647071,
// boot_slots boot_a/boot_b, pin_rule already-converted, and a libreecho-ota-v3
// plan. A Lidar unit is already Kaeru fastboot, so the installer has no Amonet
// payload for it and must never reach flash:brick or a boot-chain write.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILES,
  PIN_RULE_ALREADY_CONVERTED,
  PIN_RULE_AMONET_PAYLOAD,
  pinRuleFor,
  payloadForProfile,
  payloadNameCandidates,
  profileForProduct,
  requiresConvertedFastboot,
} from './profiles.js';
import {
  assessIdentity,
  STAGES,
  parseFastbootBytes,
  readFastbootIdentity,
  submitUnlockPayload,
} from './stages.js';
import { directPhaseCommand } from './direct-install.js';
import {
  COMBINED_SCHEMA,
  installableBoards,
  parseBundleManifest,
  parseTargetsJson,
  profileForBoard,
  requiredMembersForTarget,
  targetForBoard,
  targetsForRelease,
} from './targets.js';

const quiet = { line() {}, info() {}, ok() {}, warn() {}, error() {}, command() {}, endProgress() {} };
const capture = () => {
  const ok = [];
  const warn = [];
  return { ok, warn, terminal: { ok: (m) => ok.push(m), warn: (m) => warn.push(m) } };
};

const lidar = PROFILES.find((profile) => profile.id === 'lidar');
const radar = PROFILES.find((profile) => profile.id === 'radar');
const biscuit = PROFILES.find((profile) => profile.id === 'biscuit');
const USERDATA_BYTES = 9647071 * 512;
const BOOT_BYTES = 32768 * 512;

function lidarIdentity(overrides = {}) {
  return {
    product: 'LIDAR',
    unlockStatus: 'true',
    lkBuild: '2f7d1b6-20260101_120000',
    plBuild: '',
    kaeruVersion: '2.0.0-abcdef',
    maxDownload: '0x6d00000',
    serialRaw: 'LIDAR-0001',
    secure: 'false',
    rpmbState: '',
    partitionSizes: {
      userdata: String(USERDATA_BYTES),
      boot_a: String(BOOT_BYTES),
      boot_b: String(BOOT_BYTES),
    },
    serialMasked: 'LIDAR-…0001',
    profile: lidar,
    ...overrides,
  };
}

const TAG = 'lidar-build-abc123';
const LIDAR_PREFIX = `libreecho-${TAG}`;
const TARGETS_JSON = JSON.stringify({
  schema: COMBINED_SCHEMA,
  release: TAG,
  targets: [{ board: 'lidar', prefix: LIDAR_PREFIX }],
});
// The descriptor's names and geometry are still checked while the board is
// unaccepted; only selection is refused. Read the entry directly so these gates
// stay covered without asking targetForBoard to offer a board it must not.
const lidarTarget = () => {
  const entry = parseTargetsJson(TARGETS_JSON).targets.find((target) => target.board === 'lidar');
  assert.ok(entry, 'the Lidar descriptor entry must stay parseable');
  return entry;
};

function lidarManifest(overrides = {}) {
  const fields = {
    schema: '1',
    protocol: '2',
    release: TAG,
    device: 'lidar',
    target: 'lidar',
    fastboot_products: 'LIDAR',
    soc: 'mt8167',
    hw_profile: 'lidar@1',
    architecture: 'armv7',
    image_profile: 'ota',
    userdata_sectors: '9647071',
    ...overrides,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

// --- profile contract -------------------------------------------------------

test('the Lidar profile declares the installer contract and no Amonet payload', () => {
  assert.ok(lidar, 'no Lidar profile is declared');
  assert.equal(lidar.product, 'LIDAR');
  assert.equal(lidar.board, 'lidar');
  assert.equal(lidar.slug, 'lidar');
  assert.equal(lidar.socId, 'mt8167');
  assert.equal(lidar.hwProfile, 'lidar@1');
  assert.equal(lidar.pinRule, PIN_RULE_ALREADY_CONVERTED);
  assert.deepEqual(lidar.bootSlots, ['boot_a', 'boot_b']);
  assert.deepEqual(lidar.userdataContractSectors, [9647071]);
  assert.equal(lidar.archive, undefined, 'Lidar must not declare an Amonet archive');
  assert.equal(lidar.lkBuildMap, undefined, 'Lidar must not declare an LK payload map');
  assert.equal(lidar.fallbackPayload, undefined, 'Lidar must not declare a fallback payload');
  assert.deepEqual(payloadNameCandidates(lidar), []);
});

test('the Lidar OTA plan is the libreecho-ota-v3 control set', () => {
  assert.deepEqual(lidar.otaPlan, {
    schema: 'libreecho-product-target-plan-v3',
    format: 'libreecho-ota-v3',
    manifestVersion: 1,
    board: 'lidar',
    soc: 'mt8167',
    architecture: 'armv7',
    kernelArch: 'arm64',
    imageProfile: 'ota',
    transactionType: 'system',
    serviceProfile: 'production',
    commitPolicy: 'after-slot-confirm',
    minimumUpdaterSchema: 3,
    bootFilename: 'boot.img',
    bootSize: 16777216,
    featureIds: ['airplay2', 'tts', 'wakeword', 'stt', 'assistant'],
  });
});

test('Radar and Biscuit keep the Amonet pin rule and their exact pins', () => {
  for (const profile of [radar, biscuit]) {
    assert.equal(pinRuleFor(profile), PIN_RULE_AMONET_PAYLOAD);
    assert.equal(requiresConvertedFastboot(profile), false);
    assert.equal(profile.pinRule, undefined, 'an existing profile gained a new required field');
  }
  assert.equal(payloadForProfile(radar, '59779ca-20220524_183401').payload, 'fastbrick-20220524.img');
  assert.equal(payloadForProfile(biscuit, '63cb91b-20221007_072309').payload, 'fastbrick-20221007.img');
});

// --- selection --------------------------------------------------------------

test('LIDAR is declared but not offered while hardware acceptance is pending', () => {
  assert.equal(lidar.hardwareAccepted, false);
  assert.equal(installableBoards().some((board) => board.board === 'lidar'), false,
    'an unaccepted Lidar board appeared in the device chooser');
  assert.equal(profileForProduct('LIDAR'), lidar);
  assert.equal(profileForProduct(' lidar '), lidar);
  assert.equal(profileForBoard('lidar'), lidar);
  assert.equal(profileForProduct('LIDAR_FAKE'), null);
  assert.equal(profileForBoard('lidar_plus'), null);
});

test('a forced Lidar selection is refused before any target resolves', () => {
  assert.deepEqual(targetsForRelease({ tag: TAG, targetsJson: TARGETS_JSON }), []);
  assert.throws(() => targetForBoard({ tag: TAG, board: 'lidar', targetsJson: TARGETS_JSON }), /hardware acceptance/i);
});

test('no LK build, opt-in or fallback can select an unlock payload for Lidar', () => {
  assert.equal(payloadForProfile(lidar, '2f7d1b6-20260101_120000'), null);
  assert.equal(payloadForProfile(lidar, '2f7d1b6-20260101_120000', { allowUnpinned: true }), null);
});

test('the unlock stage refuses Lidar before flash:brick', async () => {
  const calls = [];
  const client = { flash: async (...args) => { calls.push(args); } };
  await assert.rejects(
    submitUnlockPayload({ client, profile: lidar, lkBuild: '2f7d1b6-20260101_120000',
      payloadBytes: new Uint8Array([1, 2, 3]), payloadName: 'fastbrick.img', serialRaw: 'LIDAR-0001',
      terminal: quiet, allowUnpinned: true }),
    /Kaeru|Amonet|boot chain/i,
  );
  assert.deepEqual(calls, [], 'an unlock payload reached flash:brick for Lidar');
});

test('the Lidar stage plan writes only userdata plus its boot slots and takes no backup', () => {
  const plan = STAGES.map((stage) => stage.id);
  // The browser plan is the direct-userdata chain: no backup, dump or pull stage.
  assert.ok(!plan.some((id) => /backup|dump|pull|fetch/i.test(id)), `a backup-like stage appeared: ${plan}`);
  assert.deepEqual(lidar.bootSlots, ['boot_a', 'boot_b']);
  const invocation = 'b'.repeat(64);
  for (const phase of ['prepare', 'initialize', 'transfer', 'finalize']) {
    const command = directPhaseCommand({
      phase, bundleManifestSha256: 'a'.repeat(64), target: 'lidar', release: TAG, invocationId: invocation,
    });
    assert.match(command, new RegExp(`--phase ${phase}\\b`));
    assert.doesNotMatch(command, /flash|erase|backup|dump|pull|fetch/i);
  }
  // Outside the fixed protocol phases, the only partitions the profile names are
  // userdata (its contract) and the two boot slots; no boot-chain partition.
  const namedPartitions = [...new Set(['userdata', ...lidar.bootSlots])];
  assert.deepEqual(namedPartitions, ['userdata', 'boot_a', 'boot_b']);
  for (const forbidden of ['boot0', 'boot1', 'gpt', 'gpt_backup', 'lk_a', 'lk_b', 'tee1', 'tee2', 'expdb', 'misc', 'persist']) {
    assert.ok(!namedPartitions.includes(forbidden), `the Lidar plan names ${forbidden}`);
  }
});

// --- identity accept / reject ----------------------------------------------

test('readFastbootIdentity reads the Kaeru build and the Lidar partition geometry', async () => {
  const lines = [];
  const values = {
    product: 'LIDAR', unlock_status: 'true', lk_build_desc: '2f7d1b6-20260101_120000',
    'kaeru-version': '2.0.0-abcdef', serialno: 'LIDAR-0001', 'max-download-size': '0x6d00000',
    'partition-size:userdata': String(USERDATA_BYTES),
    'partition-size:boot_a': String(BOOT_BYTES),
    'partition-size:boot_b': String(BOOT_BYTES),
  };
  const identity = await readFastbootIdentity({ getVar: async (name) => values[name] ?? '' },
    { line: (line) => lines.push(line), warn: () => {} });
  assert.equal(identity.profile, lidar);
  assert.equal(identity.kaeruVersion, '2.0.0-abcdef');
  assert.deepEqual(identity.partitionSizes, {
    userdata: String(USERDATA_BYTES), boot_a: String(BOOT_BYTES), boot_b: String(BOOT_BYTES),
  });
  assert.ok(lines.some((line) => line.includes('kaeru-version') && line.includes('2.0.0-abcdef')));
  assert.ok(!lines.join('\n').includes('LIDAR-0001'), 'the serial leaked into the log');
});

test('Radar still issues exactly its old getvars, with no partition-size reads', async () => {
  const asked = [];
  await readFastbootIdentity({ getVar: async (name) => { asked.push(name); return ''; } }, quiet);
  assert.ok(!asked.some((name) => name.startsWith('partition-size:')),
    'Radar gained a new fastboot query');
});

test('a LIDAR unit that names its Kaeru build and geometry is accepted', () => {
  const { ok, warn, terminal } = capture();
  const assessment = assessIdentity(lidarIdentity(), terminal);
  assert.deepEqual(assessment.findings, []);
  assert.ok(ok.some((line) => /recognised target.*Lidar|Lidar/i.test(line)));
  assert.deepEqual(warn, []);
});

test('a LIDAR product without a Kaeru build is refused', () => {
  for (const kaeruVersion of ['', undefined]) {
    const assessment = assessIdentity(lidarIdentity({ kaeruVersion }), quiet);
    assert.ok(assessment.findings.some((finding) => /Kaeru/i.test(finding)),
      `missing kaeru-version ${kaeruVersion} was accepted`);
  }
});

test('a LIDAR unit with the wrong userdata or a missing boot slot is refused', () => {
  const wrongUserdata = assessIdentity(lidarIdentity({
    partitionSizes: { userdata: String(32768 * 512), boot_a: String(BOOT_BYTES), boot_b: String(BOOT_BYTES) },
  }), quiet);
  assert.ok(wrongUserdata.findings.some((finding) => /userdata/i.test(finding)));

  const missingSlot = assessIdentity(lidarIdentity({
    partitionSizes: { userdata: String(USERDATA_BYTES), boot_a: String(BOOT_BYTES) },
  }), quiet);
  assert.ok(missingSlot.findings.some((finding) => /boot_b/i.test(finding)));
});

test('a Lidar unit with a Radar build selected is warned before Run', () => {
  const { warn, terminal } = capture();
  const assessment = assessIdentity(lidarIdentity(), terminal, { selectedBoard: radar.board });
  assert.deepEqual(assessment.findings, []);
  assert.equal(warn.length, 1);
  assert.match(warn[0], /radar_puffin/);
  assert.match(warn[0], /lidar/i);
});

test('unknown products are refused with the full supported list', () => {
  const assessment = assessIdentity({ product: 'PINEAPPLE', profile: null, serialRaw: 'X' }, quiet);
  assert.ok(assessment.findings.some((finding) => /RADAR.*BISCUIT.*LIDAR/.test(finding)));
});

// --- release and bundle gates ----------------------------------------------

test('a Lidar descriptor publishes its own names but offers no target while unaccepted', () => {
  const descriptor = parseTargetsJson(TARGETS_JSON).targets.find((target) => target.board === 'lidar');
  assert.equal(descriptor.hardwareAccepted, false);
  const members = requiredMembersForTarget(lidarTarget());
  assert.ok(members.normal.includes(`${LIDAR_PREFIX}-boot.img`));
  assert.deepEqual(members.recovery, ['libreecho-lidar-install.zip', 'libreecho-lidar-bundle.manifest']);
});

test('a Lidar target prefix outside its namespace is refused', () => {
  const data = JSON.parse(TARGETS_JSON);
  data.targets[0].prefix = 'libreecho-radar-puffin-other';
  assert.throws(() => parseTargetsJson(JSON.stringify(data)), /prefix|namespace/i);
});

test('a Lidar bundle manifest that matches the contract is accepted', () => {
  const parsed = parseBundleManifest(lidarManifest(), lidarTarget());
  assert.equal(parsed.matches, true);
  assert.equal(parsed.protocol, 2);
  assert.equal(parsed.fields.soc, 'mt8167');
});

test('a Lidar bundle is refused for a Radar product, SoC, geometry or profile', () => {
  for (const [overrides, pattern] of [
    [{ fastboot_products: 'RADAR' }, /product|device/i],
    [{ soc: 'mt8163' }, /soc/i],
    [{ userdata_sectors: '2153472' }, /userdata_sectors/i],
    [{ hw_profile: 'biscuit@0' }, /hw_profile/i],
    [{ architecture: 'arm64' }, /architecture/i],
    [{ image_profile: 'legacy' }, /image_profile/i],
    [{ device: 'radar_puffin' }, /target|device|describe/i],
  ]) {
    assert.throws(() => parseBundleManifest(lidarManifest(overrides), lidarTarget()), pattern,
      `manifest override ${JSON.stringify(overrides)} was accepted`);
  }
});

test('a Lidar bundle manifest must declare its SoC and userdata geometry', () => {
  assert.throws(() => parseBundleManifest(lidarManifest({ soc: null }), lidarTarget()), /soc/i);
  assert.throws(() => parseBundleManifest(lidarManifest({ userdata_sectors: null }), lidarTarget()), /userdata_sectors/i);
});

test('fastboot size replies parse as hex or decimal bytes', () => {
  assert.equal(parseFastbootBytes('0x12667be00'), USERDATA_BYTES);
  assert.equal(parseFastbootBytes(String(USERDATA_BYTES)), USERDATA_BYTES);
  assert.equal(parseFastbootBytes(''), null);
  assert.equal(parseFastbootBytes('not reported'), null);
});
