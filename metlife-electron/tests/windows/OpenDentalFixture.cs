using System;
using System.Drawing;
using System.Windows.Forms;
// Synthetic OD-style control: no UIA ListItems, custom painting, only Up/Down.
public class PaintedChoices : Control {
 readonly string[] items={"Credit Card","Zelle","Patient Refund","Deductible","Copays","Cash","Check","Transfer","Other","Membership","Insurance paid","Final Option"};
 int selected=-1,top=0; const int RowHeight=26;
 public string SelectedLabel {get{return selected<0?"":items[selected];}}
 public PaintedChoices(){SetStyle(ControlStyles.Selectable|ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);TabStop=true;Font=new Font("Segoe UI",12);}
 void Choose(int index){selected=Math.Max(0,Math.Min(items.Length-1,index));int rows=Math.Max(1,(Height-4)/RowHeight);if(selected<top)top=selected;if(selected>=top+rows)top=selected-rows+1;Invalidate();}
 protected override bool IsInputKey(Keys key){return key==Keys.Up||key==Keys.Down||base.IsInputKey(key);}
 protected override void OnKeyDown(KeyEventArgs e){base.OnKeyDown(e);if(e.KeyCode==Keys.Down)Choose(selected+1);if(e.KeyCode==Keys.Up)Choose(selected-1);}
 protected override void OnMouseDown(MouseEventArgs e){Focus();Choose(top+Math.Max(0,(e.Y-2)/RowHeight));base.OnMouseDown(e);}
 protected override void OnPaint(PaintEventArgs e){
  e.Graphics.Clear(Color.White);int rows=Math.Max(1,(Height-4)/RowHeight);
  for(int i=top;i<Math.Min(items.Length,top+rows);i++){
   int y=2+(i-top)*RowHeight;
   if(i==selected){using(var brush=new SolidBrush(Color.FromArgb(175,195,215)))e.Graphics.FillRectangle(brush,2,y,Width-4,RowHeight);}
   e.Graphics.DrawString(items[i],Font,Brushes.Black,new PointF(4,y+2));
  }
  e.Graphics.DrawRectangle(Pens.SlateGray,0,0,Width-1,Height-1);
 }
}
public class AccountGrid : Control {
 string[][] rows={
  new[]{"09/20/2026","RYAN","DOC","D0120","","Periodic exam","86.40"},
  new[]{"09/20/2026","RYAN","DOC","D2392","13","Restoration","150.00"},
  new[]{"09/20/2026","RYAN","DOC","D2392","14","Restoration","150.00"},
  new[]{"09/20/2026","OTHER","DOC","D1110","","Cleaning","108.00"}
 };
 int[] x={4,120,225,290,355,410,720};
 readonly System.Collections.Generic.SortedSet<int> selected=new System.Collections.Generic.SortedSet<int>{3};
 public string Selection {get{return string.Join(",",selected);}}
 public int[] SelectedRows {get{var result=new int[selected.Count];selected.CopyTo(result);return result;}}
 public string CodeAt(int row){return rows[row][3];}
 public bool ShowAll=true;bool chargesMode;
 public AccountGrid(bool charges=false){chargesMode=charges;if(charges){x=new[]{4,130,315,385,465,515,780};foreach(var row in rows)row[1]=row[1]=="RYAN"?"TEST, RYAN":"TEST, OTHER";}SetStyle(ControlStyles.Selectable|ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);TabStop=true;Font=new Font("Segoe UI",10);}
 protected override void OnMouseDown(MouseEventArgs e){
  Focus();int row=(e.Y-30)/32;if(e.Y<30||row<0||row>=rows.Length)return;
  if((ModifierKeys&Keys.Control)==0){selected.Clear();selected.Add(row);}
  else if(!selected.Remove(row))selected.Add(row);
  Invalidate();base.OnMouseDown(e);
 }
 protected override void OnPaint(PaintEventArgs e){
  e.Graphics.Clear(Color.White);
  string[] header={"Date","Patient","Prov","Code","Tth","Description","Charges"};
  if(chargesMode){
   int[] edges={0,120,310,380,460,510,775,850,970};
   string[] captions={"Date","Patient","Prov","Code","","Type","AmtOrig","AmtEnd"};
   for(int c=0;c<captions.Length;c++){
    float center=(edges[c]+edges[c+1])/2f;
    e.Graphics.DrawString(captions[c],Font,Brushes.Black,center-e.Graphics.MeasureString(captions[c],Font).Width/2,5);
    e.Graphics.DrawLine(Pens.Gray,edges[c],0,edges[c],28);
   }
  }else{for(int c=0;c<header.Length;c++)e.Graphics.DrawString(header[c],Font,Brushes.Black,new PointF(x[c],5));}
  for(int r=0;r<rows.Length;r++){
   if(chargesMode&&!ShowAll&&(r==0||r==2))continue;
   int y=30+r*32;
   if(selected.Contains(r)){using(var brush=new SolidBrush(Color.FromArgb(200,220,235)))e.Graphics.FillRectangle(brush,1,y,Width-2,32);}
   for(int c=0;c<rows[r].Length;c++)e.Graphics.DrawString(rows[r][c],Font,Brushes.Black,new PointF(x[c],y+7));
   e.Graphics.DrawLine(Pens.LightGray,0,y+31,Width,y+31);
  }
 }
}
// OD-style combo: opens an independent FormComboPicker and paints current caption above options.
public class PaintedCombo : Control {
 readonly string[] options; string current;
 public string Selected {get{return current;}}
 public PaintedCombo(string[] values,string initial){options=values;current=initial;Font=new Font("Segoe UI",10);}
 protected override void OnPaint(PaintEventArgs e){e.Graphics.Clear(Color.White);e.Graphics.DrawString(current,Font,Brushes.Black,3,2);e.Graphics.DrawRectangle(Pens.Gray,0,0,Width-1,Height-1);}
 protected override void OnMouseDown(MouseEventArgs e){
  base.OnMouseDown(e);var picker=new Form {Name="FormComboPicker",FormBorderStyle=FormBorderStyle.None,StartPosition=FormStartPosition.Manual,Location=PointToScreen(Point.Empty),Size=new Size(Width,Height+options.Length*28+4),ShowInTaskbar=false,Font=Font};
  picker.Paint+=(sender,args)=>{args.Graphics.Clear(Color.White);args.Graphics.DrawString(current,Font,Brushes.Black,3,2);for(int i=0;i<options.Length;i++)args.Graphics.DrawString(options[i],Font,Brushes.Black,3,Height+4+i*28);};
  picker.MouseDown+=(sender,args)=>{if(args.Y<Height){picker.Close();return;}int index=(args.Y-Height-3)/28;if(args.Y>=Height+3&&index>=0&&index<options.Length){current=options[index];picker.Close();Invalidate();}};
  picker.Show();
 }
}
public class PaintedCheck : Control {
 public bool Checked=false;public event Action Changed;
 protected override void OnPaint(PaintEventArgs e){e.Graphics.Clear(BackColor);e.Graphics.DrawString("Show All Charges",Font,Brushes.Black,0,3);e.Graphics.DrawRectangle(Pens.DimGray,Width-14,4,12,12);if(Checked){e.Graphics.DrawLine(Pens.DimGray,Width-12,9,Width-8,14);e.Graphics.DrawLine(Pens.DimGray,Width-8,14,Width-3,6);}}
 protected override void OnMouseDown(MouseEventArgs e){Checked=!Checked;Invalidate();if(Changed!=null)Changed();base.OnMouseDown(e);}
}
public class SplitGrid : Control {
 public readonly System.Collections.Generic.List<string> Rows=new System.Collections.Generic.List<string>{"DOC TEST, RYAN Prepayment 236.40"};
 public SplitGrid(){Font=new Font("Segoe UI",10);}
 protected override void OnPaint(PaintEventArgs e){e.Graphics.Clear(Color.White);e.Graphics.DrawString("Prov Patient Code Type Amount",Font,Brushes.Black,3,3);for(int i=0;i<Rows.Count;i++)e.Graphics.DrawString(Rows[i],Font,Brushes.Black,3,30+i*25);}
}
public class AllocationPayment : Form {
 public AllocationPayment(bool warn){
  Name="FormPayment";Text="Fixture Payment Allocation";ClientSize=new Size(1000,620);StartPosition=FormStartPosition.CenterScreen;
  var patient=new PaintedCombo(new[]{"All","OTHER","RYAN"},"All"){Name="comboPatientOutstandingFilter",Location=new Point(550,20),Size=new Size(180,25)};Controls.Add(patient);
  Controls.Add(new PaintedCombo(new[]{"All","RYAN"},"RYAN"){Name="comboPatientPaySplitsFilter",Location=new Point(10,20),Size=new Size(160,25)});
  Controls.Add(new PaintedCombo(new[]{"All","DOC"},"DOC"){Name="comboProviderPaySplitsFilter",Location=new Point(180,20),Size=new Size(160,25)});
  Controls.Add(new PaintedCombo(new[]{"None","Patient"},"Patient"){Name="comboGroupBy",Location=new Point(740,20),Size=new Size(180,25)});
  var all=new PaintedCheck{Name="checkShowAll",Location=new Point(550,60),Size=new Size(200,24)};Controls.Add(all);
  var grid=new AccountGrid(true){ShowAll=false,Name="gridCharges",Location=new Point(5,120),Size=new Size(970,180)};Controls.Add(grid);all.Changed+=()=>{grid.ShowAll=all.Checked;grid.Invalidate();};
  var splits=new SplitGrid{Name="gridSplits",Location=new Point(10,330),Size=new Size(600,180)};Controls.Add(splits);
  var total=new TextBox{Name="textSplitTotal",Text="236.40",Location=new Point(650,350)};Controls.Add(total);
  var state=new TextBox{Name="textAllocationState",Text="0|0|0",Location=new Point(650,400),Width=320};Controls.Add(state);
  int cleared=0,prompts=0,saves=0;decimal sum=0;
  var clear=new Button{Name="butClear",Text="Delete All",Location=new Point(10,550),Width=120};Controls.Add(clear);
  clear.Click+=(sender,e)=>{if(patient.Selected!="RYAN")throw new Exception("Wrong patient before clearing");cleared++;splits.Rows.Clear();splits.Invalidate();sum=0;total.Text="0.00";state.Text=cleared+"|"+prompts+"|"+saves;};
  var partial=new Button{Name="butCreatePartial",Text="Add Partials",Location=new Point(550,550),Width=120};Controls.Add(partial);
  partial.Click+=(sender,e)=>{
   foreach(int row in grid.SelectedRows){
    using(var prompt=new Form{Name="FormAmountEdit",Text="Enter Amount",ClientSize=new Size(320,140),StartPosition=FormStartPosition.CenterParent}){
     var label=new Label{Name="labelText",Text=grid.CodeAt(row),Location=new Point(20,25),Width=80};prompt.Controls.Add(label);
     var amount=new TextBox{Name="textAmount",Text="0.00",Location=new Point(120,25)};prompt.Controls.Add(amount);
     var ok=new Button{Name="butOK",Text="OK",Location=new Point(200,85)};prompt.Controls.Add(ok);
     ok.Click+=(a,b)=>{prompt.DialogResult=DialogResult.OK;};
     if(prompt.ShowDialog(this)!=DialogResult.OK)return;
     prompts++;state.Text=cleared+"|"+prompts+"|"+saves;
     if(warn){if(MessageBox.Show(this,"One or more Outstanding Charges will be negative.  Continue?","Overpaid Charge Warning",MessageBoxButtons.OKCancel)!=DialogResult.OK)return;}
     decimal value=decimal.Parse(amount.Text,System.Globalization.CultureInfo.InvariantCulture);sum+=value;
     splits.Rows.Add("DOC TEST, RYAN "+grid.CodeAt(row)+" "+value.ToString("F2",System.Globalization.CultureInfo.InvariantCulture));splits.Invalidate();total.Text=sum.ToString("F2",System.Globalization.CultureInfo.InvariantCulture);
    }
   }
  };
  var save=new Button{Name="butSave",Text="Save",Location=new Point(850,550)};Controls.Add(save);save.Click+=(sender,e)=>{saves++;state.Text=cleared+"|"+prompts+"|"+saves;};
 }
}
public class Fixture : Form {
 public Fixture() {
  Name="FormOpenDental"; Text="Open Dental {Fixture} - TEST , PERSON - 99";
  Size=new Size(900,650); StartPosition=FormStartPosition.CenterScreen;
  var account=new Panel {Name="ControlAccount",Dock=DockStyle.Fill}; Controls.Add(account);
  var amount=new TextBox {Name="textAmount",Text="35.00",Location=new Point(20,30)};account.Controls.Add(amount);
  var note=new RichTextBox {Name="textNote",Text="Synthetic fixture only",Location=new Point(20,75),Size=new Size(300,90)};account.Controls.Add(note);
  var types=new ListBox {Name="listPayType",Location=new Point(20,180),Size=new Size(200,80)};
  types.Items.AddRange(new object[]{"Credit Card","Insurance Paid"});account.Controls.Add(types);
  var painted=new PaintedChoices {Name="listCustomPayType",Location=new Point(400,30),Size=new Size(260,134)};account.Controls.Add(painted);
  var capturedImage=Image.FromFile(System.IO.Path.Combine(Application.StartupPath,"payment-type-r5.png"));
  var capturedList=new PictureBox{Name="listCapturedPayType",Image=capturedImage,Location=new Point(680,25),Size=capturedImage.Size};account.Controls.Add(capturedList);
  FormClosed+=(sender,e)=>capturedImage.Dispose();
  var headerImage=Image.FromFile(System.IO.Path.Combine(Application.StartupPath,"outstanding-header-r5.png"));
  account.Controls.Add(new PictureBox{Name="headerCapturedCharges",Image=headerImage,SizeMode=PictureBoxSizeMode.StretchImage,Location=new Point(5,580),Size=new Size(850,26)});
  FormClosed+=(sender,e)=>headerImage.Dispose();
  var selection=new TextBox {Name="textPaintedSelection",ReadOnly=true,Location=new Point(400,180),Width=260};account.Controls.Add(selection);
  var timer=new Timer {Interval=50};timer.Tick+=(sender,e)=>{selection.Text=painted.SelectedLabel;};timer.Start();
  var accountGrid=new AccountGrid {Name="gridAccount",Location=new Point(5,350),Size=new Size(850,180)};account.Controls.Add(accountGrid);
  var gridSelection=new TextBox {Name="textAccountSelection",Location=new Point(400,550),Width=260,ReadOnly=true};account.Controls.Add(gridSelection);
  timer.Tick+=(sender,e)=>{gridSelection.Text=accountGrid.Selection;};
  var action=new Button {Name="butAction",Text="Action",Location=new Point(250,290)};
  action.Click+=(sender,e)=>{amount.Text="77.00";};account.Controls.Add(action);
  var allocation=new Button{Name="butAllocation",Text="Allocation fixture",Location=new Point(20,550),Width=160};account.Controls.Add(allocation);
  allocation.Click+=(sender,e)=>{using(var payment=new AllocationPayment(false))payment.ShowDialog(this);};
  var warning=new Button{Name="butAllocationWarning",Text="Warning fixture",Location=new Point(200,550),Width=160};account.Controls.Add(warning);
  warning.Click+=(sender,e)=>{using(var payment=new AllocationPayment(true))payment.ShowDialog(this);};
  var popup=new Button {Name="butPopup",Text="Open fixture popup",Location=new Point(20,290),Size=new Size(200,35)};
  popup.Click+=(sender,e)=>{using(var child=new Form {Name="FormPayment",Text="Fixture Payment",Size=new Size(400,250)}){
   child.Controls.Add(new TextBox {Name="textCheckNum",Text="FIXTURE",Location=new Point(20,30)});
   child.ShowDialog(this);
  }};account.Controls.Add(popup);
 }
 [STAThread] public static void Main(){
  Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
  try{Application.EnableVisualStyles();Application.Run(new Fixture());}
  catch(Exception error){System.IO.File.WriteAllText(Application.ExecutablePath+".error.txt",error.ToString());Environment.Exit(1);}
 }
}
