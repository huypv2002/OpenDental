const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("sms", {
  call: (action, payload) => ipcRenderer.invoke("sms:call", action, payload),
  subscribe: (callback) => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on("sms:event", listener);
    return () => ipcRenderer.removeListener("sms:event", listener);
  },
});
