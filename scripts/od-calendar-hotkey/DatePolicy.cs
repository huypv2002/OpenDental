using System;
using System.Globalization;
using System.Text.RegularExpressions;
namespace LukOdCalendarHotkey {
 public static class DatePolicy {
  public static DateTime Parse(string value,CultureInfo culture) {
   value=Normalize(value);
   Match numeric=Regex.Match(value,@"^(\d{1,4})([-/.])(\d{1,2})\2(\d{1,4})$");
   if(numeric.Success) {
    int first=Int32.Parse(numeric.Groups[1].Value,CultureInfo.InvariantCulture);
    int middle=Int32.Parse(numeric.Groups[3].Value,CultureInfo.InvariantCulture);
    int last=Int32.Parse(numeric.Groups[4].Value,CultureInfo.InvariantCulture);
    if(numeric.Groups[1].Length==4) return MakeDate(first,middle,last);
    if(numeric.Groups[4].Length==4) {
     bool monthFirst=MonthFirst(culture);
     return MakeDate(last,monthFirst?first:middle,monthFirst?middle:first);
    }
   }
   DateTime date;
   if(!DateTime.TryParseExact(value,culture.DateTimeFormat.ShortDatePattern,culture,DateTimeStyles.AllowWhiteSpaces,out date))
    throw new InvalidOperationException("Unsupported date format. Shape="+Regex.Replace(value,@"\d","#")+"; Windows pattern="+culture.DateTimeFormat.ShortDatePattern+". No date was changed.");
   return date.Date;
  }
  static string Normalize(string value) { return (value??"").Replace("\u200e","").Replace("\u200f","").Trim(); }
  static bool MonthFirst(CultureInfo culture) {
   string pattern=culture.DateTimeFormat.ShortDatePattern;
   int m=pattern.IndexOf('M'), d=pattern.IndexOf('d');
   if(m<0 || d<0) throw new InvalidOperationException("Cannot determine Windows month/day order.");
   return m<d;
  }
  static DateTime MakeDate(int year,int month,int day) {
   try { return new DateTime(year,month,day); }
   catch(ArgumentOutOfRangeException) { throw new InvalidOperationException("Date is invalid for the Windows month/day order. No date was changed."); }
  }
  public static string Format(DateTime target,string observed,CultureInfo culture) {
   Match numeric=Regex.Match(Normalize(observed),@"^(\d{1,4})([-/.])(\d{1,2})\2(\d{1,4})$");
   if(numeric.Success && (numeric.Groups[1].Length==4 || numeric.Groups[4].Length==4)) {
    string separator="'"+numeric.Groups[2].Value+"'";
    string pattern=numeric.Groups[1].Length==4 ? "yyyy"+separator+"MM"+separator+"dd"
     : MonthFirst(culture)?"MM"+separator+"dd"+separator+"yyyy":"dd"+separator+"MM"+separator+"yyyy";
    return target.ToString(pattern,CultureInfo.InvariantCulture);
   }
   return target.ToString(culture.DateTimeFormat.ShortDatePattern,culture);
  }
  public static DateTime BackSixMonths(DateTime selected) { return selected.Date.AddMonths(-6); }
 }
}
