const {contextBridge,ipcRenderer}=require('electron');
const allowed=new Set(['reconnect-server','login-server','save-payment','verify-save','connect-server','disconnect-server','search-patients','patient-documents','open-document','state','import-pdf','import-snapshot','choose-folder','scan','watch','config','pdf-bytes','open-pdf','inspect-od','fill-preview','close-preview','export-plan','remove']);
contextBridge.exposeInMainWorld('metlife',{
 call:(op,arg)=>{if(!allowed.has(op))return Promise.reject(new Error('Unknown action'));return ipcRenderer.invoke('metlife:call',op,arg);},
 onState:callback=>{const fn=(_event,state)=>callback(state);ipcRenderer.on('metlife:state',fn);return()=>ipcRenderer.removeListener('metlife:state',fn);}
});
