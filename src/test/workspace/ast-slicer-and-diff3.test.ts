/**
 * Section-Scoped 3-Way Merge (diff3MergeSection) & Fence-Aware AST Integration Test Suite
 *
 * Verifies Commit Gate 5 requirements:
 * 1. Clean section 3-way merges with object and positional overloads.
 * 2. Sub-line merge and false conflict resolution.
 * 3. Real conflict handling quarantined with status: 'conflict_quarantined'.
 * 4. Markdown syntax violation handling quarantined with status: 'syntax_invalid'.
 * 5. Non-existent heading slug handling.
 * 6. Algebraic replacement invariant check:
 *    liveDoc.slice(0, hunk.from) + hunk.replacementText + liveDoc.slice(hunk.to) === mergedDocumentContent
 * 7. Fence awareness: '#' comment lines inside code blocks never fool slicing or diff3 merging.
 */

import { describe, it, expect } from 'vitest';
import {
  diff3MergeSection,
  type SectionMergeOutcome,
} from '@/lib/sync/diff3';
import {
  parseMarkdownHeadingTree,
  extractSectionBySlug,
} from '@/core/ast/heading-slicer';

/**
 * Validates the algebraic replacement invariant for any clean section merge:
 * Splicing replacementText into liveDocument at [from, to] must strictly equal mergedDocumentContent.
 */
function assertAlgebraicInvariant(liveDoc: string, outcome: SectionMergeOutcome): void {
  const reconstructed =
    liveDoc.slice(0, outcome.hunkRange.from) +
    outcome.hunkRange.replacementText +
    liveDoc.slice(outcome.hunkRange.to);

  expect(reconstructed).toBe(outcome.mergedDocumentContent);
}

describe('Section-Scoped 3-Way Merge (diff3MergeSection) & AST Slicer Suite', () => {
  // =========================================================================
  // 1. Clean Section 3-Way Merges & Parameter Overload Parity
  // =========================================================================
  describe('1. Clean Section 3-Way Merges & Overloads', () => {
    const liveDoc = [
      '# Document Title',
      'Introductory overview paragraph.',
      '',
      '## Target Section',
      'Line 1: Local human update here.',
      'Line 2: Common base content.',
      '',
      '## Trailing Section',
      'Trailing untouched content.',
    ].join('\n');

    const baseSection = [
      '## Target Section',
      'Line 1: Original base line 1.',
      'Line 2: Common base content.',
    ].join('\n');

    const agentProposedSection = [
      '## Target Section',
      'Line 1: Original base line 1.',
      'Line 2: Common base content with remote agent enhancement.',
    ].join('\n');

    it('merges cleanly using object parameter signature and satisfies algebraic invariant', () => {
      const outcome = diff3MergeSection({
        liveDocumentContent: liveDoc,
        baseSectionContent: baseSection,
        agentProposedSectionContent: agentProposedSection,
        headingSlug: 'target-section',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.diagnostics).toBeUndefined();
      expect(outcome.mergedDocumentContent).toContain('Line 1: Local human update here.');
      expect(outcome.mergedDocumentContent).toContain(
        'Line 2: Common base content with remote agent enhancement.'
      );
      expect(outcome.mergedDocumentContent).toContain('Trailing untouched content.');
      expect(outcome.mergedDocumentContent).toContain('Introductory overview paragraph.');

      assertAlgebraicInvariant(liveDoc, outcome);
    });

    it('merges cleanly using positional parameter signature and produces identical output to object overload', () => {
      const outcomeObj = diff3MergeSection({
        liveDocumentContent: liveDoc,
        baseSectionContent: baseSection,
        agentProposedSectionContent: agentProposedSection,
        headingSlug: 'target-section',
      });

      const outcomePos = diff3MergeSection(
        liveDoc,
        baseSection,
        agentProposedSection,
        'target-section'
      );

      expect(outcomePos.status).toBe(outcomeObj.status);
      expect(outcomePos.mergedDocumentContent).toBe(outcomeObj.mergedDocumentContent);
      expect(outcomePos.hunkRange).toEqual(outcomeObj.hunkRange);
      assertAlgebraicInvariant(liveDoc, outcomePos);
    });

    it('cleanly accepts remote agent changes when live matches base', () => {
      const doc = [
        '# Alpha',
        'Alpha body.',
        '',
        '# Beta',
        'Original Beta body.',
        '',
        '# Gamma',
        'Gamma body.',
      ].join('\n');

      const baseSec = '# Beta\nOriginal Beta body.';
      const agentSec = '# Beta\nUpdated Beta body by agent.\nAdded line by agent.';

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'beta',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toContain('Updated Beta body by agent.');
      expect(outcome.mergedDocumentContent).toContain('Added line by agent.');
      expect(outcome.mergedDocumentContent).toContain('# Alpha\nAlpha body.');
      expect(outcome.mergedDocumentContent).toContain('# Gamma\nGamma body.');
      assertAlgebraicInvariant(doc, outcome);
    });

    it('cleanly preserves local changes when agent matches base', () => {
      const doc = [
        '# Header',
        'Human made this modification locally.',
        '',
        '# Footer',
        'Footer content.',
      ].join('\n');

      const baseSec = '# Header\nInitial header text.\n';
      const agentSec = '# Header\nInitial header text.\n';

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'header',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toBe(doc);
      expect(outcome.hunkRange.replacementText).toBe(
        '# Header\nHuman made this modification locally.\n'
      );
      assertAlgebraicInvariant(doc, outcome);
    });

    it('cleanly merges first section (top-of-document H1) preserving subsequent sections', () => {
      const doc = [
        '# Intro',
        'Initial intro sentence.',
        '',
        '# Next Topic',
        'Next topic body.',
      ].join('\n');

      const baseSec = '# Intro\nInitial intro sentence.\n';
      const agentSec = '# Intro\nInitial intro sentence.\nAdded footnote by agent.\n';

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'intro',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toBe(
        [
          '# Intro',
          'Initial intro sentence.',
          'Added footnote by agent.',
          '',
          '# Next Topic',
          'Next topic body.',
        ].join('\n')
      );
      assertAlgebraicInvariant(doc, outcome);
    });

    it('cleanly merges last section (tail of document) without adding unintended trailing characters', () => {
      const doc = [
        '# Topic One',
        'First topic content.',
        '',
        '# Final Topic',
        'Tail content line 1.',
      ].join('\n');

      const baseSec = '# Final Topic\nTail content line 1.';
      const agentSec = '# Final Topic\nTail content line 1.\nTail content line 2.';

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'final-topic',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toBe(
        ['# Topic One', 'First topic content.', '', '# Final Topic', 'Tail content line 1.', 'Tail content line 2.'].join('\n')
      );
      assertAlgebraicInvariant(doc, outcome);
    });

    it('cleanly merges multilingual and Arabic section content', () => {
      const doc = [
        '# البداية',
        'هذا نص المقدمة باللغة العربية.',
        '',
        '## التوثيق الفني',
        'السطر الأول: قام المستخدم بتحديثه هنا.',
        'السطر الثاني: نص ثابت.',
        '',
        '## الخاتمة',
        'تمت المراجعة.',
      ].join('\n');

      const baseSec = [
        '## التوثيق الفني',
        'السطر الأول: النص الأصلي.',
        'السطر الثاني: نص ثابت.',
      ].join('\n');

      const agentSec = [
        '## التوثيق الفني',
        'السطر الأول: النص الأصلي.',
        'السطر الثاني: نص ثابت مع إضافات الوكيل الذكي.',
      ].join('\n');

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'التوثيق-الفني',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toContain('السطر الأول: قام المستخدم بتحديثه هنا.');
      expect(outcome.mergedDocumentContent).toContain('السطر الثاني: نص ثابت مع إضافات الوكيل الذكي.');
      expect(outcome.mergedDocumentContent).toContain('هذا نص المقدمة باللغة العربية.');
      expect(outcome.mergedDocumentContent).toContain('تمت المراجعة.');
      assertAlgebraicInvariant(doc, outcome);
    });

    it('handles documents with Windows CRLF line endings correctly', () => {
      const docCRLF = '# Section\r\nLine 1 human edit.\r\nLine 2 base.\r\n\r\n# Next\r\nNext content.';
      const baseSec = '# Section\r\nLine 1 original.\r\nLine 2 base.';
      const agentSec = '# Section\r\nLine 1 original.\r\nLine 2 base with remote add.';

      const outcome = diff3MergeSection({
        liveDocumentContent: docCRLF,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'section',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toContain('Line 1 human edit.');
      expect(outcome.mergedDocumentContent).toContain('Line 2 base with remote add.');
      assertAlgebraicInvariant(docCRLF, outcome);
    });
  });

  // =========================================================================
  // 2. Sub-Line Merge and False Conflict Resolution
  // =========================================================================
  describe('2. Sub-Line Merge & False Conflict Resolution', () => {
    it('resolves false conflict cleanly when both local and agent apply identical edits', () => {
      const doc = [
        '# Settings',
        'cacheEnabled: true',
        'maxConnections: 100',
      ].join('\n');

      const baseSec = [
        '# Settings',
        'cacheEnabled: false',
        'maxConnections: 10',
      ].join('\n');

      // Both human and agent simultaneously updated cacheEnabled to true and maxConnections to 100
      const agentSec = [
        '# Settings',
        'cacheEnabled: true',
        'maxConnections: 100',
      ].join('\n');

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'settings',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toBe(doc);
      assertAlgebraicInvariant(doc, outcome);
    });

    it('performs sub-line word merge cleanly when edits on the same line are disjoint', () => {
      const baseLine = 'The primary database runs on PostgreSQL version 15.';
      const localLine = 'The active database runs on PostgreSQL version 15.'; // modified beginning
      const agentLine = 'The primary database runs on PostgreSQL version 16.'; // modified ending

      const doc = [
        '# Architecture',
        localLine,
        '',
        '# Next Block',
        'Preserved block.',
      ].join('\n');

      const baseSec = ['# Architecture', baseLine, ''].join('\n');
      const agentSec = ['# Architecture', agentLine, ''].join('\n');

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'architecture',
      });

      expect(outcome.status).toBe('clean');
      // Sub-line merge combines: "The active database runs on PostgreSQL version 16."
      expect(outcome.mergedDocumentContent).toContain(
        'The active database runs on PostgreSQL version 16.'
      );
      assertAlgebraicInvariant(doc, outcome);
    });

    it('performs sub-line word merge on Arabic text with disjoint modifications', () => {
      const baseLine = 'يعمل النظام الرئيسي على خادم مستقل بسرعة قياسية.';
      const localLine = 'يعمل النظام السحابي على خادم مستقل بسرعة قياسية.'; // كلمة "السحابي"
      const agentLine = 'يعمل النظام الرئيسي على خادم مستقل بكفاءة فائقة.'; // عبارة "بكفاءة فائقة"

      const doc = ['# الخوادم', localLine].join('\n');
      const baseSec = ['# الخوادم', baseLine].join('\n');
      const agentSec = ['# الخوادم', agentLine].join('\n');

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'الخوادم',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toContain(
        'يعمل النظام السحابي على خادم مستقل بكفاءة فائقة.'
      );
      assertAlgebraicInvariant(doc, outcome);
    });
  });

  // =========================================================================
  // 3. Real Conflict Handling & Quarantine Protection
  // =========================================================================
  describe('3. Real Conflict Handling & Quarantine Protection', () => {
    const liveDoc = [
      '# API Overview',
      'This API is designed for client-server communication.',
      '',
      '## Authentication',
      'Human chose OAuth 2.0 with PKCE for security.',
      '',
      '## Endpoints',
      'Endpoints description.',
    ].join('\n');

    const baseSection = [
      '## Authentication',
      'The system uses Basic Auth for authentication.',
    ].join('\n');

    const agentProposedSection = [
      '## Authentication',
      'Agent chose JWT Bearer Tokens with Ed25519 for authentication.',
    ].join('\n');

    it('quarantines real conflicting edits with status "conflict_quarantined"', () => {
      const outcome = diff3MergeSection({
        liveDocumentContent: liveDoc,
        baseSectionContent: baseSection,
        agentProposedSectionContent: agentProposedSection,
        headingSlug: 'authentication',
      });

      expect(outcome.status).toBe('conflict_quarantined');
      expect(outcome.diagnostics).toContain('Unresolved conflict markers in merged section');
    });

    it('strictly preserves live document content intact in mergedDocumentContent during quarantine', () => {
      const outcome = diff3MergeSection({
        liveDocumentContent: liveDoc,
        baseSectionContent: baseSection,
        agentProposedSectionContent: agentProposedSection,
        headingSlug: 'authentication',
      });

      expect(outcome.status).toBe('conflict_quarantined');
      // Live document content must NEVER be corrupted with conflict markers
      expect(outcome.mergedDocumentContent).toBe(liveDoc);
      expect(outcome.mergedDocumentContent).not.toContain('<<<<<<< LOCAL');
      expect(outcome.mergedDocumentContent).not.toContain('>>>>>>> REMOTE');
    });

    it('returns standard git/diff3 conflict markers in hunkRange.replacementText for review', () => {
      const outcome = diff3MergeSection({
        liveDocumentContent: liveDoc,
        baseSectionContent: baseSection,
        agentProposedSectionContent: agentProposedSection,
        headingSlug: 'authentication',
      });

      expect(outcome.status).toBe('conflict_quarantined');
      expect(outcome.hunkRange.replacementText).toContain('<<<<<<< LOCAL');
      expect(outcome.hunkRange.replacementText).toContain('Human chose OAuth 2.0 with PKCE');
      expect(outcome.hunkRange.replacementText).toContain('=======');
      expect(outcome.hunkRange.replacementText).toContain('Agent chose JWT Bearer Tokens');
      expect(outcome.hunkRange.replacementText).toContain('>>>>>>> REMOTE');
    });

    it('accurately identifies hunkRange bounds corresponding to the section in liveDocument', () => {
      const outcome = diff3MergeSection({
        liveDocumentContent: liveDoc,
        baseSectionContent: baseSection,
        agentProposedSectionContent: agentProposedSection,
        headingSlug: 'authentication',
      });

      const extracted = extractSectionBySlug(liveDoc, 'authentication');
      expect(extracted).not.toBeNull();
      expect(outcome.hunkRange.from).toBe(extracted!.startOffset);
      expect(outcome.hunkRange.to).toBe(extracted!.endOffset);
    });

    it('handles conflicting line deletions vs line edits with quarantine', () => {
      const doc = [
        '# Policy',
        'Line A',
        // Line B was deleted by human
        'Line C',
      ].join('\n');

      const base = [
        '# Policy',
        'Line A',
        'Line B base text',
        'Line C',
      ].join('\n');

      const agent = [
        '# Policy',
        'Line A',
        'Line B modified heavily by agent',
        'Line C',
      ].join('\n');

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: base,
        agentProposedSectionContent: agent,
        headingSlug: 'policy',
      });

      expect(outcome.status).toBe('conflict_quarantined');
      expect(outcome.mergedDocumentContent).toBe(doc);
      expect(outcome.hunkRange.replacementText).toContain('<<<<<<< LOCAL');
    });
  });

  // =========================================================================
  // 4. Markdown Syntax Violation Handling & Quarantine Protection
  // =========================================================================
  describe('4. Markdown Syntax Violation Handling', () => {
    const liveDoc = [
      '# Code Guide',
      'Standard guide overview.',
      '',
      '## Implementation',
      'function execute(): void {',
      '  console.log("running");',
      '}',
      '',
      '## Next Steps',
      'Next step content.',
    ].join('\n');

    const baseSection = [
      '## Implementation',
      'function execute(): void {',
      '  console.log("running");',
      '}',
    ].join('\n');

    it('quarantines merge when agent proposes an unclosed fenced code block', () => {
      // Agent introduces opening fence ```typescript without closing it
      const brokenAgentSection = [
        '## Implementation',
        '```typescript',
        'function execute(): void {',
        '  console.log("agent updated");',
        '}',
        // Missing closing ```
      ].join('\n');

      const outcome = diff3MergeSection({
        liveDocumentContent: liveDoc,
        baseSectionContent: baseSection,
        agentProposedSectionContent: brokenAgentSection,
        headingSlug: 'implementation',
      });

      expect(outcome.status).toBe('syntax_invalid');
      expect(outcome.mergedDocumentContent).toBe(liveDoc); // live content preserved
      expect(outcome.diagnostics).toBeDefined();
      expect(
        outcome.diagnostics?.some((d) => d.includes('Unclosed fenced code block'))
      ).toBe(true);
    });

    it('quarantines merge when agent proposes a malformed GFM table (column count mismatch)', () => {
      const docWithTable = [
        '# Metrics',
        'Table section below.',
        '',
        '## Latency Table',
        '| Metric | Value |',
        '| --- | --- |',
        '| p50 | 10ms |',
        '',
        '## Summary',
        'Summary text.',
      ].join('\n');

      const baseSec = [
        '## Latency Table',
        '| Metric | Value |',
        '| --- | --- |',
        '| p50 | 10ms |',
      ].join('\n');

      // Agent proposes table delimiter with 3 columns while header has 2 columns
      const brokenTableAgent = [
        '## Latency Table',
        '| Metric | Value |',
        '| --- | --- | --- |',
        '| p50 | 10ms | extra |',
      ].join('\n');

      const outcome = diff3MergeSection({
        liveDocumentContent: docWithTable,
        baseSectionContent: baseSec,
        agentProposedSectionContent: brokenTableAgent,
        headingSlug: 'latency-table',
      });

      expect(outcome.status).toBe('syntax_invalid');
      expect(outcome.mergedDocumentContent).toBe(docWithTable);
      expect(
        outcome.diagnostics?.some((d) => d.includes('column count mismatch'))
      ).toBe(true);
    });

    it('quarantines merge when agent introduces an orphan table delimiter row without header', () => {
      const doc = [
        '# Notes',
        '## Info',
        'Text before.',
      ].join('\n');

      const baseSec = '## Info\nText before.';
      const brokenAgent = '## Info\n| --- | --- |\n| a | b |';

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: brokenAgent,
        headingSlug: 'info',
      });

      expect(outcome.status).toBe('syntax_invalid');
      expect(outcome.mergedDocumentContent).toBe(doc);
      expect(
        outcome.diagnostics?.some((d) => d.includes('orphan delimiter row'))
      ).toBe(true);
    });

    it('quarantines merge when agent introduces unclosed bold syntax (**)', () => {
      const doc = ['# Terms', '## Disclaimer', 'Standard disclaimer.'].join('\n');
      const baseSec = '## Disclaimer\nStandard disclaimer.';
      const brokenAgent = '## Disclaimer\n**Critical warning without closing asterisks.';

      const outcome = diff3MergeSection({
        liveDocumentContent: doc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: brokenAgent,
        headingSlug: 'disclaimer',
      });

      expect(outcome.status).toBe('syntax_invalid');
      expect(outcome.mergedDocumentContent).toBe(doc);
      expect(
        outcome.diagnostics?.some((d) => d.includes('Unclosed bold delimiter'))
      ).toBe(true);
    });
  });

  // =========================================================================
  // 5. Non-Existent Heading Slug Handling
  // =========================================================================
  describe('5. Non-Existent Heading Slug Handling', () => {
    const liveDoc = [
      '# Main Title',
      'Some paragraph.',
      '',
      '## Known Section',
      'Content here.',
    ].join('\n');

    it('returns status "syntax_invalid" when target heading slug does not exist in live document', () => {
      const outcome = diff3MergeSection({
        liveDocumentContent: liveDoc,
        baseSectionContent: '## Non Existent\nBase content.',
        agentProposedSectionContent: '## Non Existent\nAgent content.',
        headingSlug: 'non-existent-section',
      });

      expect(outcome.status).toBe('syntax_invalid');
      expect(outcome.mergedDocumentContent).toBe(liveDoc);
      expect(outcome.hunkRange).toEqual({ from: 0, to: 0, replacementText: '' });
      expect(outcome.diagnostics).toEqual([
        'Heading slug not found in live document: non-existent-section',
      ]);
    });

    it('returns status "syntax_invalid" when given an empty heading slug', () => {
      const outcome = diff3MergeSection({
        liveDocumentContent: liveDoc,
        baseSectionContent: 'content',
        agentProposedSectionContent: 'content',
        headingSlug: '',
      });

      expect(outcome.status).toBe('syntax_invalid');
      expect(outcome.mergedDocumentContent).toBe(liveDoc);
      expect(outcome.hunkRange).toEqual({ from: 0, to: 0, replacementText: '' });
      expect(outcome.diagnostics?.[0]).toContain('Heading slug not found in live document');
    });
  });

  // =========================================================================
  // 6. Fence Awareness: '#' Lines Inside Code Blocks Never Fool Slicer & Diff3
  // =========================================================================
  describe('6. Fence-Aware Heading Slicing & Diff3 Slicing Immunity', () => {
    const docWithCodeBlocks = [
      '# Project Overview',
      'Document overview text.',
      '',
      '## Setup Instructions',
      'Follow these steps in terminal:',
      '```bash',
      '#!/bin/bash',
      '# This is a comment inside bash script',
      '## This is not a heading node',
      '### Even level 3 comment is ignored',
      'echo "Installing LUGX dependencies"',
      'npm install',
      '```',
      'Post-script instructions.',
      '',
      '## Verification',
      'Run verification suite:',
      '```python',
      '# Python comment here',
      'def verify():',
      '    # another comment',
      '    return True',
      '```',
      '',
      '# Conclusion',
      'Final remarks.',
    ].join('\n');

    it('parses heading tree ignoring all "#" lines inside fenced code blocks', () => {
      const headings = parseMarkdownHeadingTree(docWithCodeBlocks);
      const slugs = headings.map((h) => h.headingSlug);

      expect(slugs).toEqual([
        'project-overview',
        'setup-instructions',
        'verification',
        'conclusion',
      ]);

      // None of the bash or python comments leaked into heading nodes
      expect(slugs).not.toContain('this-is-a-comment-inside-bash-script');
      expect(slugs).not.toContain('this-is-not-a-heading-node');
      expect(slugs).not.toContain('even-level-3-comment-is-ignored');
      expect(slugs).not.toContain('python-comment-here');
    });

    it('extractSectionBySlug scopes the full section containing code fences with comments', () => {
      const section = extractSectionBySlug(docWithCodeBlocks, 'setup-instructions');
      expect(section).not.toBeNull();

      expect(section!.heading.title).toBe('Setup Instructions');
      expect(section!.heading.level).toBe(2);
      expect(section!.sectionContent).toContain('```bash');
      expect(section!.sectionContent).toContain('# This is a comment inside bash script');
      expect(section!.sectionContent).toContain('Post-script instructions.');
      // Should NOT include the next heading at level 2
      expect(section!.sectionContent).not.toContain('## Verification');
    });

    it('cleanly merges section containing code blocks with "#" comments', () => {
      const section = extractSectionBySlug(docWithCodeBlocks, 'setup-instructions')!;
      const baseSec = section.sectionContent;

      // Agent updates the bash script and adds a comment
      const agentSec = [
        '## Setup Instructions',
        'Follow these steps in terminal:',
        '```bash',
        '#!/bin/bash',
        '# This is a comment inside bash script',
        '# Added new bash comment by agent',
        'echo "Installing LUGX dependencies and plugins"',
        'npm install --legacy-peer-deps',
        '```',
        'Post-script instructions.',
      ].join('\n');

      const outcome = diff3MergeSection({
        liveDocumentContent: docWithCodeBlocks,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'setup-instructions',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toContain('# Added new bash comment by agent');
      expect(outcome.mergedDocumentContent).toContain('npm install --legacy-peer-deps');
      expect(outcome.mergedDocumentContent).toContain('## Verification');
      expect(outcome.mergedDocumentContent).toContain('# Conclusion');

      assertAlgebraicInvariant(docWithCodeBlocks, outcome);
    });

    it('handles tilde code fences (~~~) containing "#" comments', () => {
      const tildeDoc = [
        '# Config',
        'Configuration details.',
        '',
        '## YAML Config',
        '~~~yaml',
        '# Top-level comment',
        'version: 2',
        '# Database settings',
        'db: postgres',
        '~~~',
        'End of config.',
        '',
        '# Next Topic',
        'Next topic body.',
      ].join('\n');

      const headings = parseMarkdownHeadingTree(tildeDoc);
      expect(headings.map((h) => h.headingSlug)).toEqual(['config', 'yaml-config', 'next-topic']);

      const section = extractSectionBySlug(tildeDoc, 'yaml-config');
      expect(section).not.toBeNull();
      expect(section!.sectionContent).toContain('~~~yaml');
      expect(section!.sectionContent).toContain('# Database settings');

      const baseSec = section!.sectionContent;
      const agentSec = baseSec.replace('db: postgres', 'db: postgresql\n# Added port\nport: 5432');

      const outcome = diff3MergeSection({
        liveDocumentContent: tildeDoc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'yaml-config',
      });

      expect(outcome.status).toBe('clean');
      expect(outcome.mergedDocumentContent).toContain('port: 5432');
      expect(outcome.mergedDocumentContent).toContain('# Added port');
      assertAlgebraicInvariant(tildeDoc, outcome);
    });
  });

  // =========================================================================
  // 7. Comprehensive Algebraic Invariant Across Diverse Topologies
  // =========================================================================
  describe('7. Comprehensive Algebraic Invariant Across Diverse Topologies', () => {
    it('satisfies invariant when merging nested subsections (H1 -> H2 -> H3)', () => {
      const complexDoc = [
        '# Grandparent H1',
        'Grandparent intro.',
        '',
        '## Parent H2',
        'Parent intro line.',
        '',
        '### Child H3 Alpha',
        'Alpha body line 1.',
        'Alpha body line 2.',
        '',
        '### Child H3 Beta',
        'Beta body line 1.',
        '',
        '## Sibling Parent H2',
        'Sibling parent intro.',
      ].join('\n');

      // Test 1: Splicing into Child H3 Alpha
      const alphaSec = extractSectionBySlug(complexDoc, 'child-h3-alpha')!;
      const agentAlpha = [
        '### Child H3 Alpha',
        'Alpha body line 1.',
        'Alpha body line 2 with agent addition.',
      ].join('\n');

      const outcomeAlpha = diff3MergeSection({
        liveDocumentContent: complexDoc,
        baseSectionContent: alphaSec.sectionContent,
        agentProposedSectionContent: agentAlpha,
        headingSlug: 'child-h3-alpha',
      });

      expect(outcomeAlpha.status).toBe('clean');
      assertAlgebraicInvariant(complexDoc, outcomeAlpha);

      // Verify sibling H3 Beta and other sections remain intact
      expect(outcomeAlpha.mergedDocumentContent).toContain('### Child H3 Beta');
      expect(outcomeAlpha.mergedDocumentContent).toContain('Sibling parent intro.');

      // Test 2: Splicing into Parent H2 (which encompasses its child H3 nodes)
      const parentSec = extractSectionBySlug(complexDoc, 'parent-h2')!;
      // Parent section includes Child H3 Alpha and Beta until next H2
      expect(parentSec.sectionContent).toContain('### Child H3 Alpha');
      expect(parentSec.sectionContent).toContain('### Child H3 Beta');

      const agentParent = parentSec.sectionContent.replace(
        'Parent intro line.',
        'Parent intro line with enhanced architectural guidelines.'
      );

      const outcomeParent = diff3MergeSection({
        liveDocumentContent: complexDoc,
        baseSectionContent: parentSec.sectionContent,
        agentProposedSectionContent: agentParent,
        headingSlug: 'parent-h2',
      });

      expect(outcomeParent.status).toBe('clean');
      assertAlgebraicInvariant(complexDoc, outcomeParent);
    });

    it('satisfies invariant on single-heading document', () => {
      const singleDoc = '# Only Heading\nSole content line.';
      const baseSec = singleDoc;
      const agentSec = '# Only Heading\nSole content line.\nSecond line.';

      const outcome = diff3MergeSection({
        liveDocumentContent: singleDoc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'only-heading',
      });

      expect(outcome.status).toBe('clean');
      assertAlgebraicInvariant(singleDoc, outcome);
    });

    it('satisfies invariant when section has empty body (heading title only)', () => {
      // Case 1: Immediately adjacent headings without intervening blank line
      const compactDoc = [
        '# Section A',
        '# Section B',
        'Body of B.',
      ].join('\n');

      const baseCompact = '# Section A';
      const agentCompact = '# Section A\nNewly authored body for section A.';

      const outcomeCompact = diff3MergeSection({
        liveDocumentContent: compactDoc,
        baseSectionContent: baseCompact,
        agentProposedSectionContent: agentCompact,
        headingSlug: 'section-a',
      });

      expect(outcomeCompact.status).toBe('clean');
      expect(outcomeCompact.mergedDocumentContent).toContain('Newly authored body for section A.');
      expect(outcomeCompact.mergedDocumentContent).toContain('# Section B\nBody of B.');
      assertAlgebraicInvariant(compactDoc, outcomeCompact);

      // Case 2: Empty section with intervening blank line
      const blankDoc = [
        '# Section X',
        '',
        '# Section Y',
        'Body of Y.',
      ].join('\n');

      const baseBlank = '# Section X\n';
      const agentBlank = '# Section X\nNewly authored body for section X.\n';

      const outcomeBlank = diff3MergeSection({
        liveDocumentContent: blankDoc,
        baseSectionContent: baseBlank,
        agentProposedSectionContent: agentBlank,
        headingSlug: 'section-x',
      });

      expect(outcomeBlank.status).toBe('clean');
      expect(outcomeBlank.mergedDocumentContent).toContain('Newly authored body for section X.');
      expect(outcomeBlank.mergedDocumentContent).toContain('# Section Y\nBody of Y.');
      assertAlgebraicInvariant(blankDoc, outcomeBlank);
    });

    it('satisfies invariant when consecutive headings have no blank lines in between', () => {
      const compactDoc = [
        '# Title 1',
        '# Title 2',
        'Body 2',
        '# Title 3',
      ].join('\n');

      const baseSec = '# Title 2\nBody 2';
      const agentSec = '# Title 2\nBody 2 enhanced';

      const outcome = diff3MergeSection({
        liveDocumentContent: compactDoc,
        baseSectionContent: baseSec,
        agentProposedSectionContent: agentSec,
        headingSlug: 'title-2',
      });

      expect(outcome.status).toBe('clean');
      assertAlgebraicInvariant(compactDoc, outcome);
      expect(outcome.mergedDocumentContent).toBe(
        ['# Title 1', '# Title 2', 'Body 2 enhanced', '# Title 3'].join('\n')
      );
    });
  });
});
