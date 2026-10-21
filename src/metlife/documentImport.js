// OD 24.3 Document defaults, matching the public Document/DocumentCrud model.
// Include supported fields explicitly so MariaDB strict mode never needs implicit defaults.
export function documentInsert(fields,columns){
 const row={...fields,ImgType:0,IsFlipped:0,DegreesRotated:0,ToothNumbers:'',Note:'',SigIsTopaz:0,Signature:'',CropX:0,CropY:0,CropW:0,CropH:0,WindowingMin:0,WindowingMax:0,MountItemNum:0,RawBase64:'',Thumbnail:'',ExternalGUID:'',ExternalSource:'None',ProvNum:0,IsCropOld:0,OcrResponseData:'',ImageCaptureType:0,PrintHeading:0};
 const names=new Set(columns.map(c=>c.COLUMN_NAME));
 if(!columns.find(c=>c.COLUMN_NAME==='DocNum')?.EXTRA?.includes('auto_increment'))throw new Error('document.DocNum cần AUTO_INCREMENT.');
 if(['DocCategory','PatNum','FileName','Description','DateCreated'].some(k=>!names.has(k)))throw new Error('Schema document thiếu trường lưu Finished Claims.');
 for(const c of columns){
  if(c.COLUMN_NAME==='DocNum'||c.EXTRA?.includes('GENERATED')||Object.hasOwn(row,c.COLUMN_NAME))continue;
  if(c.IS_NULLABLE==='NO'&&c.COLUMN_DEFAULT===null)throw new Error(`document: chưa hỗ trợ trường bắt buộc ${c.COLUMN_NAME}.`);
 }
 const entries=Object.entries(row).filter(([key])=>names.has(key));
 return {sql:`INSERT INTO document (${entries.map(([k])=>'`'+k+'`').join(',')}) VALUES (${entries.map(()=>'?').join(',')})`,values:entries.map(([,v])=>v)};
}
