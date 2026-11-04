using System;
using System.Globalization;
namespace LukOdCalendarHotkey {
 public static class DatePolicy {
  public static DateTime Parse(string value,CultureInfo culture) {
   DateTime date;
   if(!DateTime.TryParseExact(value,culture.DateTimeFormat.ShortDatePattern,culture,DateTimeStyles.AllowWhiteSpaces,out date))
    throw new InvalidOperationException("Date field does not match the Windows short-date format. No date was changed.");
   return date.Date;
  }
  public static DateTime BackSixMonths(DateTime selected) { return selected.Date.AddMonths(-6); }
 }
}
