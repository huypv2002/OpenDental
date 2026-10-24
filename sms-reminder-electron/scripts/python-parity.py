"""Run original Python pure helpers, isolated from Qt/DB/Phone Link imports."""
import ast,json,re,sys
from datetime import date,datetime,timedelta
from types import SimpleNamespace
from pathlib import Path
source=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]/'sms-reminder-tool/sms_reminder_app.py'
names=set('digits_only format_us_phone wireless_phone_value patient_name patient_age patient_gender patient_salutation patient_formal_first_name vietnamese_title vietnamese_salutation display_date parse_datetime display_time weekday_en weekday_vi display_date_short reminder_offset_days relative_day_labels SafeTemplateValues first_template_value patient_user_name render_custom_default_placeholders render_message template_uses_appointment_datetime template_key_for_language_keys infer_template_country template_label BridgeClient'.split())
tree=ast.parse(source.read_text()); selected=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names]
selected += [n for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t,ast.Name) and t.id == 'CUSTOM_DEFAULT_PLACEHOLDER_PREFIXES' for t in n.targets)]
module=ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),*selected],type_ignores=[])
ns=dict(date=date,datetime=datetime,timedelta=timedelta,re=re,Any=object,clinic_today=lambda:date(2026,10,11),APPOINTMENT_DATETIME_PLACEHOLDERS=set('date date_full date_short weekday weekday_vi relative_day relative_day_es relative_day_vi time time_lower'.split()))
exec(compile(ast.fix_missing_locations(module),str(source),'exec'),ns)
config=SimpleNamespace(clinic_name='LUK Demo',clinic_phone='281-555-0100',review_link='https://example.com/review')
keys=['formal_first_name','salutation','vi_title','vi_title_cap','vi_salutation','first_name','last_name','patient_name','user_name','email','password','age','relative_day','relative_day_es','relative_day_vi','weekday','weekday_vi','date','date_full','date_short','time','time_lower','clinic_name','clinic_phone','phone','apt_num','pat_num','review_link','holiday_name','procedure_codes','last_proc_date','last_pending_proc_date','procedure_descriptions']
fixtures=[]
for age in [20,25,26,45,46,65,66,None]:
 for gender in [0,1,2]:
  for country in ['US','VI','ES']:
   for apt in ['', '2026-10-11 09:30:00','2026-10-12 13:00:00','2026-10-19 00:15:00']:
    row=dict(FName='Alex',LName='Demo',PatNum=101,AptNum=10,Gender=gender,_TemplateCountry=country,WirelessPhone='2815550101',Phone='2815550101',AptDateTime=apt,Birthdate=f'{2026-age}-01-01' if age is not None else '',Email='demo@example.com',_HolidayName='Demo holiday',ProcedureCodes='D1110',LastProcDate='2026-02-01',LastPendingProcDate='2026-08-01',ProcedureDescriptions='Demo cleaning')
    template='|'.join('{'+key+'}' for key in keys)+'|{unknown}|{custom_Hello there}|{password_demo123}|{{first_name}}'
    fixtures.append(dict(row=row,template=template,expected=ns['render_message'](config,row,template)))
contracts=[]
repo=ns['BridgeClient'](config)
for kind,method in [('dashboard','log_result'),('patient','log_patient_result'),('recall','log_recall_result'),('treatment','log_treatment_result'),('holiday','log_campaign_result')]:
 for status in ['sent','needs-review','failed','dry-run']:
  for phone in ['2815550101','+1 (281) 555-0101']:
   row=dict(FName='Alex',LName='Demo',PatNum=101,AptNum=10,AptDateTime='2026-10-19 09:30:00',Phone=phone,WirelessPhone=phone,_Kind=kind,_TemplateKey='US',_CampaignType='birthday',_CampaignName='10/19/2026',ProcedureCodes='D1110',LastProcDate='2026-02-01',LastPendingProcDate='2026-08-01')
   captured=[]
   repo.request=lambda method,route,**kwargs:captured.append(dict(path=route,body=kwargs['json']))
   getattr(repo,method)(row,'Demo message',status,'Demo error' if status=='failed' else '',phone=ns['wireless_phone_value'](row))
   contracts.append(dict(row=row,status=status,error='Demo error' if status=='failed' else '',expected=captured[0]))
phones=[]
for value in ['2815550101','+1 (281) 555-0101','281932002','abc','','(281) 555-0101']:
 row=dict(WirelessPhone=value)
 phones.append(dict(row=row,expected=ns['wireless_phone_value'](row),digits=ns['digits_only'](value)))
print(json.dumps(dict(config=vars(config),today='2026-10-11',fixtures=fixtures,contracts=contracts,phones=phones)))
