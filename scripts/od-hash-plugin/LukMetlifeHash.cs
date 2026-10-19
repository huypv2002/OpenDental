// Loaded by OpenDental.exe as a PluginBase. Computes PaySplits.HashFields for NEW
// split values only. No database reads/writes, no UI, no CDT patching.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using OpenDentBusiness;

namespace LukMetlifeHash {
 public class Plugin : PluginBase {
  static Thread pipeWorker;
  static Thread httpWorker;
  static readonly object initLock = new object();

  public Plugin() {
   StartServers();
  }

  public override Form Host {
   set {
    base.Host = value;
    StartServers();
   }
  }

  static void StartServers() {
   lock (initLock) {
    if (pipeWorker == null) {
     pipeWorker = new Thread(ServePipe) { IsBackground = true, Name = "LukMetlifeHashPipe" };
     pipeWorker.Start();
    }
    if (httpWorker == null) {
     httpWorker = new Thread(ServeHttp) { IsBackground = true, Name = "LukMetlifeHashHttp" };
     httpWorker.Start();
    }
   }
  }

  static void ServePipe() {
   for (;;) {
    try {
     using (var pipe = new NamedPipeServerStream("luk-metlife-paysplit-hash", PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None)) {
      pipe.WaitForConnection();
      using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, true))
      using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { NewLine = "\n", AutoFlush = true }) {
       string raw = reader.ReadLine();
       string resp = ComputeHashesJson(raw);
       writer.WriteLine(resp);
      }
     }
    } catch {
     Thread.Sleep(250);
    }
   }
  }

  static void ServeHttp() {
   HttpListener listener = null;
   int[] ports = new int[] { 30099, 30098 };
   foreach (int port in ports) {
    try {
     var l = new HttpListener();
     l.Prefixes.Add("http://127.0.0.1:" + port + "/hash/");
     l.Prefixes.Add("http://localhost:" + port + "/hash/");
     // Attempt wildcard prefix if allowed by URL ACL or running as admin
     try { l.Prefixes.Add("http://*:" + port + "/hash/"); } catch { }
     l.Start();
     listener = l;
     break;
    } catch {
     if (listener != null) { try { listener.Close(); } catch { } }
    }
   }
   if (listener == null) return;

   for (;;) {
    try {
     var ctx = listener.GetContext();
     ThreadPool.QueueUserWorkItem(state => {
      var c = (HttpListenerContext)state;
      try {
       c.Response.Headers.Add("Access-Control-Allow-Origin", "*");
       c.Response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
       c.Response.Headers.Add("Access-Control-Allow-Headers", "Content-Type");
       if (c.Request.HttpMethod == "OPTIONS") {
        c.Response.StatusCode = 200;
        c.Response.Close();
        return;
       }
       if (c.Request.HttpMethod == "GET") {
        System.Reflection.Assembly entry = System.Reflection.Assembly.GetEntryAssembly();
        string entryName = (entry != null) ? entry.FullName : "";
        byte[] health = Encoding.UTF8.GetBytes("{\"ok\":true,\"service\":\"LukMetlifeHash\",\"process\":\"OpenDental\",\"assembly\":\"" + Escape(entryName) + "\"}");
        c.Response.ContentType = "application/json";
        c.Response.OutputStream.Write(health, 0, health.Length);
        c.Response.Close();
        return;
       }
       if (c.Request.HttpMethod == "POST") {
        string body;
        using (var r = new StreamReader(c.Request.InputStream, Encoding.UTF8)) {
         body = r.ReadToEnd();
        }
        string jsonResp = ComputeHashesJson(body);
        byte[] respBytes = Encoding.UTF8.GetBytes(jsonResp);
        c.Response.ContentType = "application/json";
        c.Response.OutputStream.Write(respBytes, 0, respBytes.Length);
        c.Response.Close();
        return;
       }
       c.Response.StatusCode = 405;
       c.Response.Close();
      } catch {
       try { c.Response.StatusCode = 500; c.Response.Close(); } catch { }
      }
     }, ctx);
    } catch {
     Thread.Sleep(500);
    }
   }
  }

  static List<PaySplit> ParseSplits(string json) {
   var list = new List<PaySplit>();
   MatchCollection splitMatches = Regex.Matches(json, @"\{[^{}]*\}");
   foreach (Match m in splitMatches) {
    var patMatch = Regex.Match(m.Value, @"""patNum""\s*:\s*""?([1-9]\d{0,17})""?", RegexOptions.IgnoreCase);
    var amtMatch = Regex.Match(m.Value, @"""amount""\s*:\s*""?(\d+\.\d{2})""?", RegexOptions.IgnoreCase);
    var dateMatch = Regex.Match(m.Value, @"""date""\s*:\s*""?(\d{4}-\d{2}-\d{2})""?", RegexOptions.IgnoreCase);
    if (patMatch.Success && amtMatch.Success && dateMatch.Success) {
     var split = new PaySplit();
     split.PatNum = long.Parse(patMatch.Groups[1].Value, CultureInfo.InvariantCulture);
     split.SplitAmt = double.Parse(amtMatch.Groups[1].Value, CultureInfo.InvariantCulture);
     split.DatePay = DateTime.ParseExact(dateMatch.Groups[1].Value, "yyyy-MM-dd", CultureInfo.InvariantCulture);
     list.Add(split);
    }
   }
   return list;
  }

  static string ComputeHashesJson(string rawJson) {
   if (string.IsNullOrWhiteSpace(rawJson) || rawJson.Length > 65536) {
    return "{\"ok\":false,\"error\":\"Invalid hash request.\"}";
   }
   try {
    var splits = ParseSplits(rawJson);
    if (splits.Count == 0) {
     throw new InvalidOperationException("No splits found in hash request.");
    }
    var hashes = new List<string>();
    foreach (var split in splits) {
     string hash = PaySplits.HashFields(split);
     if (string.IsNullOrWhiteSpace(hash) || hash.Length > 4096 || hash.EndsWith("Exception", StringComparison.Ordinal) || hash.IndexOf(' ') >= 0) {
      throw new InvalidOperationException("Open Dental did not return a valid SecurityHash (" + hash + ").");
     }
     hashes.Add(hash);
    }
    return "{\"ok\":true,\"hashes\":[" + string.Join(",", hashes.ConvertAll(h => "\"" + Escape(h) + "\"").ToArray()) + "]}";
   } catch (Exception ex) {
    string msg = ex.Message ?? "Hash helper failed.";
    if (msg.Length > 400) msg = msg.Substring(0, 400);
    return "{\"ok\":false,\"error\":\"" + Escape(msg) + "\"}";
   }
  }

  static string Escape(string value) {
   return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
  }
 }
}
