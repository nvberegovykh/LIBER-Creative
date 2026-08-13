using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.Text.Json;
using System.IO;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Operates the real Rendair page hosted inside REVEX/WebView2.
/// Important: REVEX itself also contains text/file inputs, so automation is scoped
/// strictly to rendair.ai frames (or a top-level Rendair page) to avoid touching
/// REVEX controls by mistake.
/// </summary>
public static class RendairWebBridge
{
    private static bool IsRendairUri(Uri? uri) =>
        uri != null && uri.Host.EndsWith("rendair.ai", StringComparison.OrdinalIgnoreCase);

    private static async Task<bool> IsRendairFrameAsync(CoreWebView2Frame frame)
    {
        try
        {
            string raw = await frame.ExecuteScriptAsync("location.hostname || ''");
            string host = JsonSerializer.Deserialize<string>(raw) ?? "";
            return host.EndsWith("rendair.ai", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static async Task<List<CoreWebView2Frame>> GetRendairFramesAsync(IEnumerable<CoreWebView2Frame>? frames)
    {
        var output = new List<CoreWebView2Frame>();
        foreach (CoreWebView2Frame frame in frames ?? Array.Empty<CoreWebView2Frame>())
        {
            if (await IsRendairFrameAsync(frame)) output.Add(frame);
        }
        return output;
    }

    private static async Task<bool> ExecuteOnRendairAsync(
        WebView2 web,
        string script,
        IEnumerable<CoreWebView2Frame>? frames)
    {
        bool ok = false;
        if (IsRendairUri(web.Source))
        {
            try
            {
                ok = string.Equals(await web.ExecuteScriptAsync(script), "true", StringComparison.OrdinalIgnoreCase);
            }
            catch { }
        }

        foreach (CoreWebView2Frame frame in await GetRendairFramesAsync(frames))
        {
            try
            {
                if (string.Equals(await frame.ExecuteScriptAsync(script), "true", StringComparison.OrdinalIgnoreCase))
                    ok = true;
            }
            catch { }
        }
        return ok;
    }

    public static async Task<(bool ok, string message)> AttachBaseImageAsync(
        WebView2 web,
        string filePath,
        IEnumerable<CoreWebView2Frame>? frames = null)
    {
        if (web.CoreWebView2 == null)
            return (false, "Rendair browser is not initialized.");
        if (!File.Exists(filePath))
            return (false, "Revit capture was not found.");

        const string markInputScript = """
        (() => {
          if (!location.hostname.endsWith('rendair.ai')) return false;
          const all = Array.from(document.querySelectorAll('input[type="file"]'));
          if (!all.length) return false;
          const visible = all.find(e => {
            const s = getComputedStyle(e);
            const r = e.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && !e.disabled && (r.width > 0 || r.height > 0);
          });
          const target = visible || all[0];
          target.setAttribute('data-liber-rendair-upload', '1');
          return true;
        })();
        """;

        bool marked = await ExecuteOnRendairAsync(web, markInputScript, frames);
        if (!marked)
            return (false, "Rendair is open, but its image upload field is not ready yet.");

        string flatJson = await web.CoreWebView2.CallDevToolsProtocolMethodAsync(
            "DOM.getFlattenedDocument", "{\"depth\":-1,\"pierce\":true}");
        using JsonDocument flat = JsonDocument.Parse(flatJson);
        int inputNodeId = 0;
        foreach (JsonElement node in flat.RootElement.GetProperty("nodes").EnumerateArray())
        {
            if (!node.TryGetProperty("nodeName", out JsonElement nodeName) || nodeName.GetString() != "INPUT") continue;
            if (!node.TryGetProperty("attributes", out JsonElement attributes)) continue;
            string[] values = attributes.EnumerateArray().Select(value => value.GetString() ?? "").ToArray();
            for (int i = 0; i + 1 < values.Length; i += 2)
            {
                if (values[i] == "data-liber-rendair-upload" && values[i + 1] == "1")
                {
                    inputNodeId = node.GetProperty("nodeId").GetInt32();
                    break;
                }
            }
            if (inputNodeId != 0) break;
        }
        if (inputNodeId == 0)
            return (false, "Rendair upload field disappeared before the Revit capture could be attached.");

        string setFilesJson = JsonSerializer.Serialize(new
        {
            files = new[] { Path.GetFullPath(filePath) },
            nodeId = inputNodeId
        });
        await web.CoreWebView2.CallDevToolsProtocolMethodAsync("DOM.setFileInputFiles", setFilesJson);

        const string dispatchScript = """
        (() => {
          if (!location.hostname.endsWith('rendair.ai')) return false;
          const e = document.querySelector("input[data-liber-rendair-upload='1']");
          if (!e) return false;
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })();
        """;
        await ExecuteOnRendairAsync(web, dispatchScript, frames);
        return (true, "Revit capture attached to Rendair.");
    }

    public static async Task<(bool ok, string message)> InjectPromptAsync(
        WebView2 web,
        string prompt,
        IEnumerable<CoreWebView2Frame>? frames = null)
    {
        if (web.CoreWebView2 == null)
            return (false, "Rendair browser is not initialized.");

        string promptJson = JsonSerializer.Serialize(prompt);
        string script = $$"""
        (() => {
          if (!location.hostname.endsWith('rendair.ai')) return false;
          const prompt = {{promptJson}};
          const candidates = [
            ...Array.from(document.querySelectorAll('textarea')),
            ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
            ...Array.from(document.querySelectorAll('input[type="text"]'))
          ];
          const visible = candidates.filter(e => {
            const s = getComputedStyle(e); const r = e.getBoundingClientRect();
            return !e.disabled && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 8 && r.height > 8;
          });
          const target = visible.find(e => {
            const p = ((e.getAttribute('placeholder') || '') + ' ' +
                       (e.getAttribute('aria-label') || '') + ' ' +
                       (e.getAttribute('name') || '')).toLowerCase();
            return p.includes('prompt') || p.includes('describe') || p.includes('instruction');
          }) || visible.find(e => e.tagName === 'TEXTAREA');
          if (!target) return false;
          target.setAttribute('data-liber-rendair-prompt', '1');
          if (target.isContentEditable) {
            target.textContent = prompt;
            target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
          } else {
            const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(target, prompt); else target.value = prompt;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
          }
          target.focus();
          return true;
        })();
        """;

        if (await ExecuteOnRendairAsync(web, script, frames))
            return (true, "WALLT prompt injected into Rendair.");
        return (false, "Rendair prompt field is not ready yet.");
    }

    public static async Task<(bool ok, string message)> SubmitAsync(
        WebView2 web,
        IEnumerable<CoreWebView2Frame>? frames = null,
        int maxAttempts = 18)
    {
        if (web.CoreWebView2 == null)
            return (false, "Rendair browser is not initialized.");

        const string script = """
        (() => {
          if (!location.hostname.endsWith('rendair.ai')) return false;
          const prompt = document.querySelector('[data-liber-rendair-prompt="1"]');
          const scope = prompt?.closest('form') || prompt?.parentElement?.parentElement || document;
          const candidates = Array.from(scope.querySelectorAll('button, input[type="submit"]')).filter(e => {
            const s = getComputedStyle(e); const r = e.getBoundingClientRect();
            return !e.disabled && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 12 && r.height > 12;
          });
          const score = e => {
            const t = ((e.innerText || e.value || '') + ' ' + (e.getAttribute('aria-label') || '')).trim().toLowerCase();
            let n = 0;
            if (/generate|render|create|start/.test(t)) n += 10;
            if (/image|visual|result/.test(t)) n += 4;
            if (/upload|login|sign|cancel|back|menu/.test(t)) n -= 20;
            return n;
          };
          const ranked = candidates.map(e => ({e, s: score(e)})).sort((a,b) => b.s-a.s);
          const target = ranked[0]?.s > 0 ? ranked[0].e : null;
          if (!target) return false;
          target.setAttribute('data-liber-rendair-submit', '1');
          target.click();
          return true;
        })();
        """;

        for (int attempt = 0; attempt < Math.Max(1, maxAttempts); attempt++)
        {
            if (await ExecuteOnRendairAsync(web, script, frames))
                return (true, "Rendair render started automatically.");
            await Task.Delay(650);
        }
        return (false, "Rendair is prepared, but its Generate/Render control was not ready for automatic submission.");
    }
}
