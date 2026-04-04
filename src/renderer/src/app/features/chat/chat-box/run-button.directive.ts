import { AfterViewChecked, Directive, ElementRef, NgZone, inject, OnDestroy } from '@angular/core';
import { ElectronService } from '../../../core/electron.service';
import { Subscription } from 'rxjs';

interface InteractiveProcess {
  processId: string;
  wrapper: Element;
  stdout: string;
  stderr: string;
  input: HTMLInputElement;
  isComplete: boolean;
  script: string;
  language: string;
}

@Directive({
  selector: '[appRunButton]',
})
export class RunButtonDirective implements AfterViewChecked, OnDestroy {
  private readonly elementRef: ElementRef;
  private readonly electron = inject(ElectronService);
  private readonly zone = inject(NgZone);
  private readonly document = document;
  private processedButtons = new Set<Element>();
  private mutationObserver: MutationObserver | null = null;
  private interactiveProcesses = new Map<string, InteractiveProcess>();
  private scriptOutputSub: Subscription | null = null;
  private scriptCompleteSub: Subscription | null = null;

  constructor(elementRef: ElementRef) {
    this.elementRef = elementRef;

    // Subscribe to script output events
    this.scriptOutputSub = this.electron.scriptOutput$.subscribe((msg) => {
      this.zone.run(() => {
        this.handleScriptOutput(msg);
      });
    });

    this.scriptCompleteSub = this.electron.scriptComplete$.subscribe((msg) => {
      this.zone.run(() => {
        this.handleScriptComplete(msg);
      });
    });
  }

  ngAfterViewChecked(): void {
    this.attachHandlers();
  }

  ngOnDestroy(): void {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
    }
    if (this.scriptOutputSub) {
      this.scriptOutputSub.unsubscribe();
    }
    if (this.scriptCompleteSub) {
      this.scriptCompleteSub.unsubscribe();
    }
    // Kill any running interactive processes
    for (const [processId] of this.interactiveProcesses) {
      this.electron.endScript(processId);
    }
  }

  private handleScriptOutput(msg: { processId: string; type: 'stdout' | 'stderr' | 'error'; data: string }): void {
    const process = this.interactiveProcesses.get(msg.processId);
    if (!process || process.isComplete) return;

    if (msg.type === 'stdout') {
      process.stdout += msg.data;
    } else if (msg.type === 'stderr') {
      process.stderr += msg.data;
    }

    this.updateInteractiveOutput(process);
  }

  private handleScriptComplete(msg: { processId: string; exitCode: number | null }): void {
    const process = this.interactiveProcesses.get(msg.processId);
    if (!process) return;

    process.isComplete = true;

    // Convert interactive output to static output with read-more and send buttons
    this.convertToStaticOutput(process, msg.exitCode);
  }

  private convertToStaticOutput(process: InteractiveProcess, exitCode: number | null): void {
    const outputDiv = process.wrapper;
    const processId = process.processId;

    // Build static output HTML
    let outputHtml = this.buildTerminalOutputHtml(process.stdout, process.stderr, exitCode);
    outputHtml += `
      <div class="output-actions">
        <button class="read-more-btn">Read more</button>
        <button class="send-output-btn">Send as response</button>
      </div>
    `;

    // Replace the output div content
    outputDiv.innerHTML = outputHtml;
    outputDiv.classList.remove('interactive-output');
    outputDiv.removeAttribute('data-process-id');

    // Add send as response handler
    const sendBtn = outputDiv.querySelector('.send-output-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        let formattedOutput = '';
        if (process.stdout) {
          formattedOutput += `Logs:\n${process.stdout}`;
        }
        if (process.stderr) {
          if (formattedOutput) formattedOutput += '\n\n';
          formattedOutput += `Error info:\n${process.stderr}`;
        }
        if (formattedOutput) {
          this.dispatchSendResponseEvent(formattedOutput);
        }
      });
    }

    // Add read more toggle handler
    const readMoreBtn = outputDiv.querySelector('.read-more-btn');
    if (readMoreBtn) {
      readMoreBtn.addEventListener('click', () => {
        outputDiv.classList.toggle('output-expanded');
        const isExpanded = outputDiv.classList.contains('output-expanded');
        readMoreBtn.textContent = isExpanded ? 'Show less' : 'Read more';
      });
    }

    // Check if output has overflow and show read more button if needed
    requestAnimationFrame(() => {
      const terminalBody = outputDiv.querySelector('.terminal-shell-body');
      if (terminalBody && terminalBody.scrollHeight > terminalBody.clientHeight) {
        outputDiv.classList.add('has-overflow');
      }
    });

    // Remove from interactive processes map
    this.interactiveProcesses.delete(processId);
  }

  private updateInteractiveOutput(process: InteractiveProcess): void {
    const stdoutSection = process.wrapper.querySelector('.terminal-stream-stdout');
    const stderrSection = process.wrapper.querySelector('.terminal-stream-stderr');
    const stdoutPre = process.wrapper.querySelector('.terminal-output-stdout');
    const stderrPre = process.wrapper.querySelector('.terminal-output-stderr');
    const placeholder = process.wrapper.querySelector('.terminal-placeholder');
    const terminalBody = process.wrapper.querySelector('.terminal-shell-body');

    if (stdoutPre) {
      stdoutPre.textContent = process.stdout;
    }
    if (stderrPre) {
      stderrPre.textContent = process.stderr;
    }

    stdoutSection?.classList.toggle('is-hidden', !process.stdout);
    stderrSection?.classList.toggle('is-hidden', !process.stderr);
    placeholder?.classList.toggle('is-hidden', !!process.stdout || !!process.stderr);

    if (terminalBody) {
      terminalBody.scrollTop = terminalBody.scrollHeight;
    }
  }

  private attachHandlers(): void {
    // Use MutationObserver to handle dynamically added content via innerHTML
    if (!this.mutationObserver) {
      this.mutationObserver = new MutationObserver(() => {
        this.zone.runOutsideAngular(() => {
          this.findAndAttachButtons();
        });
      });

      this.mutationObserver.observe(this.elementRef.nativeElement, {
        childList: true,
        subtree: true,
      });
    }

    this.findAndAttachButtons();
  }

  private findAndAttachButtons(): void {
    const buttons = this.elementRef.nativeElement.querySelectorAll('.code-block-run-btn:not([data-attached])');
    buttons.forEach((btn: Element) => {
      if (!this.processedButtons.has(btn)) {
        this.processedButtons.add(btn);
        (btn as HTMLElement).dataset['attached'] = 'true';
        btn.addEventListener('click', (event) => this.onRunClick(event));
      }
    });
  }

  private async onRunClick(event: Event): Promise<void> {
    const btn = event.currentTarget as HTMLElement;
    const wrapper = btn.closest('.code-block-wrapper');
    if (!wrapper) {
      console.error('[RunButton] No wrapper found');
      return;
    }

    const dataScript = wrapper.getAttribute('data-script');
    const dataLanguage = wrapper.getAttribute('data-language');
    console.log('[RunButton] data-script:', dataScript);
    console.log('[RunButton] data-language:', dataLanguage);
    console.log('[RunButton] wrapper innerHTML:', wrapper.innerHTML);

    if (!dataScript) {
      // Try to get script from the code element inside
      const codeEl = wrapper.querySelector('code');
      if (codeEl) {
        console.log('[RunButton] Found code element, text content:', codeEl.textContent);
      }
    }

    let script = decodeURIComponent(dataScript || '');
    const language = decodeURIComponent(dataLanguage || '');

    console.log('[RunButton] Decoded script:', script);
    console.log('[RunButton] Language:', language);

    // Clean up the script - remove markdown code block formatting
    // This handles cases where the LLM includes extra formatting
    script = script
      .replace(/^```[\w]*\n?/gm, '')  // Remove opening code fences with language
      .replace(/```\s*$/gm, '')       // Remove closing code fences
      .replace(/^\s*\n/gm, '')         // Remove leading blank lines
      .trim();                          // Remove leading/trailing whitespace

    console.log('[RunButton] Cleaned script:', script);

    // Show loading state
    btn.setAttribute('disabled', 'true');
    btn.textContent = 'Running...';

    // Get workspace path from current global workspace
    const currentWorkspace = await this.electron.getCurrentWorkspace();
    const workspacePath = currentWorkspace?.path ?? '';

    console.log('[RunButton] Workspace path:', workspacePath);

    try {
      // Use interactive script execution
      const result = await this.electron.runScriptInteractive(script, language, workspacePath);

      console.log('[RunButton] Interactive result:', result);

      if (result.success && result.processId) {
        this.zone.run(() => {
          this.showInteractiveOutput(wrapper, result.processId!, script, language);
        });
      } else {
        this.zone.run(() => {
          this.showOutput(wrapper, '', result.error || 'Failed to start script', -1);
        });
      }
    } catch (err: any) {
      console.error('[RunButton] Error:', err);
      this.zone.run(() => {
        this.showOutput(wrapper, '', err.message || 'Unknown error');
      });
    } finally {
      btn.removeAttribute('disabled');
      btn.textContent = 'Run';
    }
  }

  private showInteractiveOutput(wrapper: Element, processId: string, script: string, language: string): void {
    // Remove existing output if any
    const existingOutput = wrapper.nextElementSibling;
    if (existingOutput?.classList.contains('code-block-output')) {
      existingOutput.remove();
    }

    const outputDiv = this.document.createElement('div');
    outputDiv.className = 'code-block-output interactive-output';
    outputDiv.setAttribute('data-process-id', processId);

    let outputHtml = `
      <div class="terminal-shell terminal-shell-running">
        <div class="terminal-shell-header">
          <div class="terminal-shell-title-row">
            <span class="terminal-shell-title">Terminal</span>
            <span class="terminal-shell-badge terminal-shell-badge-running">Running</span>
          </div>
          <button class="end-script-btn" aria-label="End command" title="End command">x</button>
        </div>
        <div class="terminal-shell-body">
          <div class="terminal-placeholder">Waiting for terminal output...</div>
          <div class="terminal-stream terminal-stream-stdout is-hidden">
            <div class="terminal-stream-label">stdout</div>
            <pre class="output-pre terminal-output terminal-output-stdout"></pre>
          </div>
          <div class="terminal-stream terminal-stream-stderr is-hidden">
            <div class="terminal-stream-label terminal-stream-label-error">stderr</div>
            <pre class="output-pre output-stderr terminal-output terminal-output-stderr"></pre>
          </div>
        </div>
      </div>
    `;
    outputHtml += `
      <div class="interactive-input-container">
        <input type="text" class="interactive-input" placeholder="Type input for the running command..." />
        <button class="interactive-submit-btn">Send</button>
      </div>
    `;

    outputDiv.innerHTML = outputHtml;

    // Create input element reference
    const inputEl = outputDiv.querySelector('.interactive-input') as HTMLInputElement;

    // Track this process
    const process: InteractiveProcess = {
      processId,
      wrapper: outputDiv,
      stdout: '',
      stderr: '',
      input: inputEl,
      isComplete: false,
      script,
      language,
    };
    this.interactiveProcesses.set(processId, process);

    // Add input handlers
    const submitBtn = outputDiv.querySelector('.interactive-submit-btn');
    const endBtn = outputDiv.querySelector('.end-script-btn') as HTMLButtonElement | null;

    submitBtn?.addEventListener('click', () => {
      const inputValue = inputEl.value;
      if (inputValue.trim()) {
        this.electron.sendScriptInput(processId, inputValue + '\n');
        inputEl.value = '';
      }
    });

    inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        const inputValue = inputEl.value;
        if (inputValue.trim()) {
          this.electron.sendScriptInput(processId, inputValue + '\n');
          inputEl.value = '';
        }
      }
    });

    endBtn?.addEventListener('click', async () => {
      // Disable the button immediately
      endBtn.disabled = true;
      endBtn.textContent = '...';
      inputEl.disabled = true;
      if (submitBtn instanceof HTMLButtonElement) {
        submitBtn.disabled = true;
      }

      // End the script
      const result = await this.electron.endScript(processId);
      if (!result.success) {
        // On error, convert to static output anyway
        this.handleScriptComplete({ processId, exitCode: -1 });
        return;
      }

      // Fallback in case the process exits but the completion event is delayed or lost.
      setTimeout(() => {
        if (this.interactiveProcesses.has(processId)) {
          this.handleScriptComplete({ processId, exitCode: -1 });
        }
      }, 1500);
    });

    wrapper.parentNode?.insertBefore(outputDiv, wrapper.nextSibling);

    // Focus the input
    inputEl.focus();
  }

  private showOutput(wrapper: Element, stdout: string, stderr: string, exitCode?: number): void {
    // Remove existing output if any
    const existingOutput = wrapper.nextElementSibling;
    if (existingOutput?.classList.contains('code-block-output')) {
      existingOutput.remove();
    }

    const outputDiv = this.document.createElement('div');
    outputDiv.className = 'code-block-output';

    let outputHtml = this.buildTerminalOutputHtml(stdout, stderr, exitCode);
    outputHtml += `
      <div class="output-actions">
        <button class="read-more-btn">Read more</button>
        <button class="send-output-btn">Send as response</button>
      </div>
    `;

    outputDiv.innerHTML = outputHtml;

    // Add send as response handler
    const sendBtn = outputDiv.querySelector('.send-output-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        let formattedOutput = '';
        if (stdout) {
          formattedOutput += `Logs:\n${stdout}`;
        }
        if (stderr) {
          if (formattedOutput) formattedOutput += '\n\n';
          formattedOutput += `Error info:\n${stderr}`;
        }
        if (formattedOutput) {
          this.dispatchSendResponseEvent(formattedOutput);
        }
      });
    }

    // Add read more toggle handler
    const readMoreBtn = outputDiv.querySelector('.read-more-btn');
    if (readMoreBtn) {
      readMoreBtn.addEventListener('click', () => {
        outputDiv.classList.toggle('output-expanded');
        const isExpanded = outputDiv.classList.contains('output-expanded');
        readMoreBtn.textContent = isExpanded ? 'Show less' : 'Read more';
      });
    }

    wrapper.parentNode?.insertBefore(outputDiv, wrapper.nextSibling);

    // Check if output has overflow and show read more button if needed
    requestAnimationFrame(() => {
      const terminalBody = outputDiv.querySelector('.terminal-shell-body');
      if (terminalBody && terminalBody.scrollHeight > terminalBody.clientHeight) {
        outputDiv.classList.add('has-overflow');
      }
    });
  }

  private buildTerminalOutputHtml(stdout: string, stderr: string, exitCode?: number | null): string {
    const hasStdout = !!stdout;
    const hasStderr = !!stderr;
    const hasOutput = hasStdout || hasStderr;
    const stateClass = exitCode === undefined || exitCode === null
      ? 'terminal-shell-badge-complete'
      : exitCode === 0
        ? 'terminal-shell-badge-complete'
        : 'terminal-shell-badge-error';
    const stateLabel = exitCode === undefined || exitCode === null
      ? 'Complete'
      : exitCode === 0
        ? 'Exit 0'
        : `Exit ${exitCode}`;

    let streamsHtml = '';

    if (hasStdout) {
      streamsHtml += `
        <div class="terminal-stream terminal-stream-stdout">
          <div class="terminal-stream-label">stdout</div>
          <pre class="output-pre terminal-output">${this.escapeHtml(stdout)}</pre>
        </div>
      `;
    }

    if (hasStderr) {
      streamsHtml += `
        <div class="terminal-stream terminal-stream-stderr">
          <div class="terminal-stream-label terminal-stream-label-error">stderr</div>
          <pre class="output-pre output-stderr terminal-output">${this.escapeHtml(stderr)}</pre>
        </div>
      `;
    }

    if (!hasOutput) {
      streamsHtml = `<div class="terminal-placeholder">No terminal output.</div>`;
    }

    return `
      <div class="terminal-shell">
        <div class="terminal-shell-header">
          <div class="terminal-shell-title-row">
            <span class="terminal-shell-title">Terminal</span>
            <span class="terminal-shell-badge ${stateClass}">${stateLabel}</span>
          </div>
        </div>
        <div class="terminal-shell-body">
          ${streamsHtml}
        </div>
      </div>
    `;
  }

  private escapeHtml(text: string): string {
    const div = this.document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private dispatchSendResponseEvent(text: string): void {
    const event = new CustomEvent('send-response', { detail: text, bubbles: true });
    this.elementRef.nativeElement.dispatchEvent(event);
  }
}
