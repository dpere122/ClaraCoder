import { BrowserWindow, Menu } from 'electron';
import type Electron from 'electron';

type TextContextArea = 'chat' | 'composer' | null;

function detectTextContextArea(win: BrowserWindow, x: number, y: number): Promise<TextContextArea> {
  return win.webContents.executeJavaScript(
    `(function () {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return null;
      if (el.closest('app-message-box')) return 'composer';
      if (el.closest('app-chat-box')) return 'chat';
      return null;
    })()`,
  );
}

function selectAllChatAtPoint(win: BrowserWindow, x: number, y: number): Promise<void> {
  return win.webContents.executeJavaScript(
    `(function () {
      const el = document.elementFromPoint(${x}, ${y})?.closest('app-chat-box .chat-box');
      if (!el) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    })()`,
  );
}

function buildComposerMenuTemplate(
  editFlags: Electron.ContextMenuParams['editFlags'],
): Electron.MenuItemConstructorOptions[] {
  const { canCopy, canCut, canPaste, canSelectAll } = editFlags;
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (canCut) {
    template.push({ role: 'cut' });
  }
  if (canCopy) {
    template.push({ role: 'copy' });
  }
  if (canPaste) {
    template.push({ role: 'paste' });
  }
  if (template.length > 0) {
    template.push({ type: 'separator' });
  }
  if (canSelectAll) {
    template.push({ role: 'selectAll' });
  }

  return template;
}

function buildChatMenuTemplate(
  win: BrowserWindow,
  params: Electron.ContextMenuParams,
): Electron.MenuItemConstructorOptions[] {
  const hasSelection = Boolean(params.selectionText?.length);
  const canCopy = hasSelection || params.editFlags.canCopy;

  return [
    {
      label: 'Copy',
      enabled: canCopy,
      click: () => {
        if (canCopy) {
          win.webContents.copy();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Select All',
      click: () => {
        void selectAllChatAtPoint(win, params.x, params.y);
      },
    },
  ];
}

/** Native copy / paste / select-all menu for chat messages and the composer input. */
export function registerSelectableTextContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    void (async () => {
      const area = await detectTextContextArea(win, params.x, params.y);
      if (!area) {
        return;
      }

      const template =
        area === 'composer'
          ? buildComposerMenuTemplate(params.editFlags)
          : buildChatMenuTemplate(win, params);

      if (template.length === 0) {
        return;
      }

      Menu.buildFromTemplate(template).popup({ window: win });
    })();
  });
}
