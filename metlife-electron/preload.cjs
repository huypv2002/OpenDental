const {contextBridge,ipcRenderer}=require('electron');
const allowed=new Set(['reconnect-server','fill-preview','save-payment','verify-save','search-patients','patient-documents','open-document','state','import-pdf','choose-folder','scan','watch','pdf-bytes','open-pdf','close-preview','remove']);
contextBridge.exposeInMainWorld('metlife',{
 call:(op,arg)=>{if(!allowed.has(op))return Promise.reject(new Error('Unknown action'));return ipcRenderer.invoke('metlife:call',op,arg);},
 onState:callback=>{const fn=(_event,state)=>callback(state);ipcRenderer.on('metlife:state',fn);return()=>ipcRenderer.removeListener('metlife:state',fn);}
});
