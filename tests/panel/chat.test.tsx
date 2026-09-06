// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'preact';
import { App } from '@/panel/components/App.tsx';
import { initialPanelState } from '@/panel/index.ts';

/**
 * The task panel is a conversation now.
 *
 * It used to be one input and two buttons, and an agent that needed to ask
 * something had nowhere to put the question: the loop stopped and a reason
 * appeared in a status row. The interaction always had the shape of a
 * conversation - the UI just did not admit it.
 *
 * These render the real component, because the last panel change that was only
 * type-checked shipped a blank side panel.
 */

function mount(props: Parameters<typeof App>[0]): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<App {...props} />, host);
  return host;
}

/*
 * The buttons are gated on `canRun` - an attached tab AND a loaded model -
 * because acting on neither is how the panel used to offer a control that could
 * only fail. The tests have to satisfy that gate or they assert nothing.
 */
const BASE = {
  state: {
    ...initialPanelState,
    attachedTab: { tabId: 1, origin: 'http://localhost:8080' },
    host: { ...initialPanelState.host, modelLoaded: true },
  },
  build: { version: '0.0.0-test', built: 'test' },
} as unknown as Parameters<typeof App>[0];

describe('the transcript', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('invites a goal when nothing has been said', () => {
    const host = mount({ ...BASE, messages: [], onRunTask: () => {} });
    expect(host.textContent).toMatch(/Tell the agent what to do/i);
  });

  it('shows both sides of the conversation', () => {
    const host = mount({
      ...BASE,
      onRunTask: () => {},
      messages: [
        { role: 'you', text: 'add a laptop to the cart' },
        { role: 'agent', text: 'Which one did you mean - Laptop Pro, or Gaming Laptop?' },
      ],
    });
    expect(host.textContent).toContain('add a laptop to the cart');
    expect(host.textContent).toContain('Which one did you mean');
    expect(host.textContent).toContain('You');
    expect(host.textContent).toContain('Agent');
  });
});

describe('the single input does both jobs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('sends a goal when nothing is outstanding', () => {
    const sent: string[] = [];
    const host = mount({
      ...BASE,
      messages: [],
      pendingQuestion: null,
      onRunTask: (g: string) => sent.push(g),
      onAnswer: () => {
        throw new Error('should not answer when no question is pending');
      },
    });
    const input = host.querySelector('#goal') as HTMLInputElement;
    input.value = 'book a flight';
    (host.querySelector('button.primary') as HTMLButtonElement).click();
    expect(sent).toEqual(['book a flight']);
  });

  it('answers instead when the agent is waiting', () => {
    /*
     * Two boxes would make the user decide which one applies, and the panel
     * already knows. The button label changes so the mode is visible.
     */
    const answered: string[] = [];
    const host = mount({
      ...BASE,
      messages: [],
      pendingQuestion: 'Which one did you mean?',
      onRunTask: () => {
        throw new Error('should not start a new task while a question is pending');
      },
      onAnswer: (a: string) => answered.push(a),
    });
    const btn = host.querySelector('button.primary') as HTMLButtonElement;
    expect(btn.textContent).toContain('Answer');
    const input = host.querySelector('#goal') as HTMLInputElement;
    input.value = 'the Gaming Laptop';
    btn.click();
    expect(answered).toEqual(['the Gaming Laptop']);
  });

  it('warns about credentials only while a question is open', () => {
    /*
     * Advice to a PERSON, not part of the conversation. A server that can put
     * text in front of the user could otherwise ask for a password inside the
     * extension's own trusted UI - the prompt forbids it, but the prompt is
     * advice to a model.
     */
    const withQ = mount({ ...BASE, messages: [], pendingQuestion: 'Which?', onAnswer: () => {} });
    expect(withQ.textContent).toMatch(/Never enter a password/i);

    document.body.innerHTML = '';
    const without = mount({ ...BASE, messages: [], pendingQuestion: null, onRunTask: () => {} });
    expect(without.textContent).not.toMatch(/Never enter a password/i);
  });

  it('sends nothing for an empty input', () => {
    const sent: string[] = [];
    const host = mount({ ...BASE, messages: [], pendingQuestion: null, onRunTask: (g: string) => sent.push(g) });
    (host.querySelector('button.primary') as HTMLButtonElement).click();
    expect(sent).toEqual([]);
  });
});

describe('the privacy proof', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders only the baked, sanitized preview and lets the user clear the live mask', () => {
    let cleared = 0;
    const host = mount({
      ...BASE,
      onClearPrivacyLens: () => {
        cleared += 1;
      },
      state: {
        ...BASE.state,
        privacyGate: {
          ...initialPanelState.privacyGate,
          redaction: { detected: 2, applied: 2, residualRisk: 'none' },
          bake: { requested: 2, applied: 2, outsideFrame: 0, bytes: 256, ms: 2 },
          prepared: {
            bytes: 480,
            imageBytes: 256,
            preview: { base64: 'c2FuaXRpemVk', format: 'jpeg', width: 10, height: 10 },
          },
          transmitted: { channel: 'cloud', modelId: 'demo-vlm' },
        },
      },
    });

    const preview = host.querySelector('img[alt="Sanitized screenshot produced by the local privacy gate"]');
    expect(preview?.getAttribute('src')).toBe('data:image/jpeg;base64,c2FuaXRpemVk');
    expect(host.textContent).toContain('Sanitized context delivered to demo-vlm');
    expect(host.textContent).not.toMatch(/original screenshot/i);

    const clear = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Clear live page mask'),
    );
    clear?.click();
    expect(cleared).toBe(1);
  });
});
