'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  state:        ()      => call('app:state'),
  ping:         ()      => call('app:ping'),
  setupAdmin:   pw      => call('setup:admin', pw),

  verifyCode:   code    => call('student:login', code),
  endSession:   ()      => call('student:logout'),
  listFolder:   p       => call('student:list', p),
  listDrives:   ()      => call('student:drives'),
  copyItem:     opts    => call('student:copy', opts),
  cancelCopy:   ()      => call('student:cancel-copy'),

  adminLogin:   pw      => call('admin:login', pw),
  adminLogout:  ()      => call('admin:logout'),
  admin: {
    listCodes:      ()          => call('admin:codes'),
    pickFolder:     ()          => call('admin:pick-folder'),
    listFolders:    ()          => call('admin:folders'),
    addFolder:      opts        => call('admin:folder-add', opts),
    updateFolder:   (id, patch) => call('admin:folder-update', id, patch),
    removeFolder:   (id, opts)  => call('admin:folder-remove', id, opts),
    issue:          opts        => call('admin:issue', opts),
    updateCode:     (id, patch) => call('admin:update-code', id, patch),
    resetUsage:     ids         => call('admin:reset-usage', ids),
    deleteCodes:    ids         => call('admin:delete-codes', ids),
    deleteExpired:  ()          => call('admin:delete-expired'),
    getSettings:    ()          => call('admin:get-settings'),
    saveSettings:   patch       => call('admin:save-settings', patch),
    changePassword: (o, n)      => call('admin:change-password', o, n),
    readLog:        ()          => call('admin:log')
  },

  onCopyProgress:   cb => ipcRenderer.on('copy-progress',   (_e, p) => cb(p)),
  onSessionExpired: cb => ipcRenderer.on('session-expired', (_e, who) => cb(who))
});
