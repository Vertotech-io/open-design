import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findSkillById, listSkills, type SkillInfo } from '../src/skills.js';
import {
  collectAdHocSkillDirs,
  resolveChatExtraAllowedDirs,
} from '../src/server.js';

// Regression coverage for ad-hoc (@-mention) skills with side files.
// PR #1636 restores skillIds processing and adds side-file staging.
// These tests verify the full chain:
//   skillIds → collectAdHocSkillDirs → resolved { id, dir } pairs → stage/allowlist

let skillsRoot: string;

function writeSkillWithSideFiles(
  root: string,
  folder: string,
  body: string,
): string {
  const dir = path.join(root, folder);
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  mkdirSync(path.join(dir, 'references'), { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${folder}\ndescription: test skill\nmode: prototype\n---\n\n${body}`,
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'assets', 'template.html'),
    '<html>template</html>',
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'references', 'guide.md'),
    '# guide',
    'utf8',
  );
  return dir;
}

beforeAll(async () => {
  skillsRoot = mkdtempSync(path.join(tmpdir(), 'od-skillids-sidefiles-'));
  writeSkillWithSideFiles(skillsRoot, 'faq-page', '## FAQ Page workflow');
  writeSkillWithSideFiles(skillsRoot, 'web-search', '## Web Search workflow');
});

afterAll(() => {
  if (skillsRoot) rmSync(skillsRoot, { recursive: true, force: true });
});

describe('collectAdHocSkillDirs', () => {
  it('resolves skillIds to { id, dir } pairs', async () => {
    const allSkills = await listSkills(skillsRoot);
    const result = collectAdHocSkillDirs(
      ['faq-page', 'web-search'],
      null,
      allSkills,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'faq-page',
      dir: path.join(skillsRoot, 'faq-page'),
    });
    expect(result[1]).toEqual({
      id: 'web-search',
      dir: path.join(skillsRoot, 'web-search'),
    });
  });

  it('filters out the effectiveSkillId so project-level skill is not duplicated', async () => {
    const allSkills = await listSkills(skillsRoot);
    const result = collectAdHocSkillDirs(
      ['faq-page', 'web-search'],
      'faq-page', // project already has faq-page
      allSkills,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('web-search');
  });

  it('deduplicates repeated skill ids', async () => {
    const allSkills = await listSkills(skillsRoot);
    const result = collectAdHocSkillDirs(
      ['faq-page', 'faq-page'],
      null,
      allSkills,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('faq-page');
  });

  it('excludes skillIds whose resolved dir matches the active skill dir', async () => {
    // Even if skillIds contains a different id (e.g. an alias) that
    // resolves to the same on-disk directory as effectiveSkillId, it
    // must be excluded because seenDir is seeded with the active skill's dir.
    const allSkills = await listSkills(skillsRoot);
    const result = collectAdHocSkillDirs(
      ['faq-page', 'web-search'],
      'faq-page', // active skill
      allSkills,
    );
    // faq-page is excluded by id match; web-search is kept
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('web-search');
    // Verify none of the results share a dir with the active skill
    const activeSkill = findSkillById(allSkills, 'faq-page');
    for (const r of result) {
      expect(r.dir).not.toBe(activeSkill!.dir);
    }
  });

  it('excludes alias id that resolves to the same dir as active skill', () => {
    // Construct a scenario where 'faq-page-v2' is an alias pointing to
    // the same on-disk directory as canonical 'faq-page'.
    const faqDir = path.join(skillsRoot, 'faq-page');
    const mockSkills: SkillInfo[] = [
      {
        id: 'faq-page',
        name: 'FAQ Page',
        description: '',
        triggers: [],
        mode: 'prototype',
        surface: 'web',
        source: 'built-in',
        craftRequires: [],
        platform: null,
        scenario: '',
        category: null,
        previewType: '',
        designSystemRequired: false,
        defaultFor: [],
        upstream: null,
        featured: null,
        fidelity: null,
        speakerNotes: null,
        animations: null,
        examplePrompt: '',
        aggregatesExamples: false,
        critiquePolicy: null,
        body: '## FAQ',
        dir: faqDir,
      },
      {
        id: 'faq-page-v2',
        name: 'FAQ Page V2',
        description: '',
        triggers: [],
        mode: 'prototype',
        surface: 'web',
        source: 'built-in',
        craftRequires: [],
        platform: null,
        scenario: '',
        category: null,
        previewType: '',
        designSystemRequired: false,
        defaultFor: [],
        upstream: null,
        featured: null,
        fidelity: null,
        speakerNotes: null,
        animations: null,
        examplePrompt: '',
        aggregatesExamples: false,
        critiquePolicy: null,
        body: '## FAQ V2',
        dir: faqDir, // same dir as canonical
      },
    ];

    // Active skill is canonical 'faq-page'; skillIds has alias 'faq-page-v2'
    const result = collectAdHocSkillDirs(
      ['faq-page-v2'],
      'faq-page',
      mockSkills,
    );
    // The alias resolves to the same dir → excluded by seenDir seed
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty/invalid input', async () => {
    const allSkills = await listSkills(skillsRoot);
    expect(collectAdHocSkillDirs([], null, allSkills)).toEqual([]);
    expect(collectAdHocSkillDirs(null, null, allSkills)).toEqual([]);
    expect(collectAdHocSkillDirs(undefined, null, allSkills)).toEqual([]);
  });

  it('skips unknown skill ids', async () => {
    const allSkills = await listSkills(skillsRoot);
    const result = collectAdHocSkillDirs(
      ['faq-page', 'nonexistent-skill'],
      null,
      allSkills,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('faq-page');
  });
});

describe('ad-hoc skill side files on disk', () => {
  it('each resolved dir contains the expected side files', async () => {
    const allSkills = await listSkills(skillsRoot);
    const result = collectAdHocSkillDirs(['faq-page'], null, allSkills);
    expect(result).toHaveLength(1);
    const { existsSync } = await import('node:fs');
    const dir = result[0]!.dir;
    expect(existsSync(path.join(dir, 'assets', 'template.html'))).toBe(true);
    expect(existsSync(path.join(dir, 'references', 'guide.md'))).toBe(true);
  });
});

describe('resolveChatExtraAllowedDirs with ad-hoc skill dirs', () => {
  it('includes ad-hoc skill dirs for non-Codex agents', async () => {
    const allSkills = await listSkills(skillsRoot);
    const resolved = collectAdHocSkillDirs(
      ['faq-page', 'web-search'],
      null,
      allSkills,
    );
    const dirs = resolved.map((r) => r.dir);

    const extraAllowed = resolveChatExtraAllowedDirs({
      agentId: 'claude',
      skillsDir: skillsRoot,
      designSystemsDir: null,
      linkedDirs: dirs,
      codexGeneratedImagesDir: null,
      existsSync: () => true,
    });

    expect(extraAllowed).toContain(path.join(skillsRoot, 'faq-page'));
    expect(extraAllowed).toContain(path.join(skillsRoot, 'web-search'));
  });

  it('deduplicates dirs in allowlist', async () => {
    const allSkills = await listSkills(skillsRoot);
    const resolved = collectAdHocSkillDirs(['faq-page'], null, allSkills);
    const dirs = resolved.map((r) => r.dir);

    // Pass the same dir twice — should appear once in the result
    const extraAllowed = resolveChatExtraAllowedDirs({
      agentId: 'claude',
      skillsDir: skillsRoot,
      designSystemsDir: null,
      linkedDirs: [...dirs, ...dirs],
      codexGeneratedImagesDir: null,
      existsSync: () => true,
    });

    const count = extraAllowed.filter(
      (d) => d === path.join(skillsRoot, 'faq-page'),
    ).length;
    expect(count).toBe(1);
  });

  it('does not include ad-hoc dirs for Codex agents', async () => {
    const allSkills = await listSkills(skillsRoot);
    const resolved = collectAdHocSkillDirs(['faq-page'], null, allSkills);
    const dirs = resolved.map((r) => r.dir);

    const extraAllowed = resolveChatExtraAllowedDirs({
      agentId: 'codex',
      skillsDir: skillsRoot,
      designSystemsDir: null,
      linkedDirs: dirs,
      codexGeneratedImagesDir: '/tmp/codex-images',
      existsSync: () => true,
    });

    expect(extraAllowed).not.toContain(path.join(skillsRoot, 'faq-page'));
    expect(extraAllowed).toContain('/tmp/codex-images');
  });
});
