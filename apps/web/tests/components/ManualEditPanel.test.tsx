import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { ManualEditPanel, emptyManualEditDraft, manualEditPatchSummary } from '../../src/components/ManualEditPanel';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';

const target: ManualEditTarget = {
  id: 'hero-title',
  kind: 'text',
  label: 'Hero Title',
  tagName: 'h1',
  className: 'hero',
  text: 'Original',
  rect: { x: 0, y: 0, width: 120, height: 40 },
  fields: { text: 'Original' },
  attributes: { 'data-od-id': 'hero-title' },
  styles: emptyManualEditStyles(),
  outerHtml: '<h1 data-od-id="hero-title">Original</h1>',
};

describe('ManualEditPanel', () => {
  let dom: JSDOM;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = dom.window.document.querySelector('#root') as HTMLDivElement;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'HTMLElement');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  it('renders the style inspector without the advanced editor entry', () => {
    renderPanel();

    expect(host.textContent).toContain('TYPOGRAPHY');
    expect(host.textContent).not.toContain('Advanced');
    expect(host.textContent).not.toContain('Content');
  });

  it('normalizes font stacks and writes a usable font-family value', () => {
    const onDraftChange = vi.fn();
    renderPanel({
      onDraftChange,
      styles: {
        ...emptyManualEditStyles(),
        fontFamily: '"Roboto", sans-serif',
      },
    });

    const fontSelect = host.querySelector('select') as HTMLSelectElement | null;
    if (!fontSelect) throw new Error('Font select not found');
    expect(fontSelect.value).toBe('Roboto, Arial, sans-serif');

    act(() => {
      fontSelect.value = 'Georgia, serif';
      fontSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });

    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      styles: expect.objectContaining({ fontFamily: 'Georgia, serif' }),
    }));
  });

  it('does not persist an unchanged target style when the inspector opens', () => {
    vi.useFakeTimers();
    try {
      const onApplyPatch = vi.fn();
      renderPanel({ onApplyPatch });

      act(() => {
        vi.advanceTimersByTime(1600);
      });

      expect(onApplyPatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not persist unchanged page styles when no target is selected', () => {
    vi.useFakeTimers();
    try {
      const onApplyPatch = vi.fn();
      renderPanel({ onApplyPatch, selectedTarget: null });

      act(() => {
        vi.advanceTimersByTime(1600);
      });

      expect(onApplyPatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('summarizes full-source history entries without rendering the full file', () => {
    const source = '<html><body>' + 'x'.repeat(10_000) + '</body></html>';

    expect(manualEditPatchSummary({ kind: 'set-full-source', source })).toBe(
      JSON.stringify({ kind: 'set-full-source', bytes: source.length }),
    );
    expect(manualEditPatchSummary({ kind: 'set-full-source', source })).not.toContain('x'.repeat(100));
  });

  function renderPanel({
    onDraftChange = vi.fn(),
    onApplyPatch = vi.fn(),
    onError = vi.fn(),
    attributesText = '{}',
    selectedTarget = target,
    styles = emptyManualEditStyles(),
  }: {
    onDraftChange?: ReturnType<typeof vi.fn>;
    onApplyPatch?: ReturnType<typeof vi.fn>;
    onError?: ReturnType<typeof vi.fn>;
    attributesText?: string;
    selectedTarget?: ManualEditTarget | null;
    styles?: ReturnType<typeof emptyManualEditStyles>;
  } = {}) {
    const draft = {
      ...emptyManualEditDraft('<html></html>'),
      text: 'Updated copy',
      attributesText,
      styles,
      outerHtml: target.outerHtml,
    };
    act(() => {
      root.render(
        <ManualEditPanel
          targets={[target]}
          selectedTarget={selectedTarget}
          draft={draft}
          history={[]}
          error={null}
          canUndo={false}
          canRedo={false}
          onSelectTarget={vi.fn()}
          onDraftChange={onDraftChange}
          onApplyPatch={onApplyPatch}
          onError={onError}
          onCancelDraft={vi.fn()}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        />,
      );
    });
  }

});
