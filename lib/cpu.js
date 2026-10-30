const os = require('os');
const { spawn } = require('child_process');

// Node has no affinity / job-object API: keep one PowerShell alive and feed it one PID per line.
// The job object's hard cap is enforced by the Windows scheduler, so the load stays flat.
const PS_SCRIPT = (mask, rate) => `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class CpuJob {
  [StructLayout(LayoutKind.Sequential)] public struct Rate { public uint Flags; public uint CpuRate; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, ref Rate i, int l);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static IntPtr Create(uint rate) {
    IntPtr j = CreateJobObject(IntPtr.Zero, null);
    Rate r = new Rate(); r.Flags = 0x5; r.CpuRate = rate; // ENABLE | HARD_CAP, in 1/100 % of the whole machine
    SetInformationJobObject(j, 15, ref r, 8);
    return j;
  }
  public static void Add(IntPtr j, int pid) {
    IntPtr p = OpenProcess(0x0101, false, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (p == IntPtr.Zero) return;
    AssignProcessToJobObject(j, p); CloseHandle(p);
  }
}
"@
$job = if (${rate} -gt 0) { [CpuJob]::Create(${rate}) } else { [IntPtr]::Zero }
$mask = [IntPtr][Int64]${mask}
while ($null -ne ($l = [Console]::In.ReadLine())) {
  $id = [int]$l.Trim()
  try { if (${mask} -gt 0) { (Get-Process -Id $id -ErrorAction Stop).ProcessorAffinity = $mask } } catch {}
  if ($job -ne [IntPtr]::Zero) { [CpuJob]::Add($job, $id) }
}`;

// One affinity mask covers at most 63 CPUs here (signed Int64 in PowerShell).
const TOTAL = os.cpus().length;
const CPUS = Math.min(63, TOTAL);

// Use the highest-numbered CPUs: CPU 0 handles most system interrupts.
const maskOf = (k) => (((1n << BigInt(k)) - 1n) << BigInt(CPUS - k)).toString();

// Pins encoder processes to `maxCores` CPU threads and caps them at `power`% of those threads,
// so the CPU runs cooler and does not hit thermal throttling.
class CpuLimiter {
  constructor({ maxCores = 0, power = 100 } = {}) {
    this.cores = Math.min(CPUS, Math.max(1, Math.round(maxCores) || CPUS));
    const pct = Math.min(100, Math.max(10, Math.round(Number(power)) || 100));
    const mask = this.cores < CPUS ? maskOf(this.cores) : '0';
    // The job cap is a share of the whole machine; scale it so `pct` means "% of each allowed thread".
    const rate = pct < 100 ? Math.max(100, Math.round((pct * this.cores * 100) / TOTAL)) : 0;
    if (process.platform !== 'win32' || (mask === '0' && !rate)) return;
    const encoded = Buffer.from(PS_SCRIPT(mask, rate), 'utf16le').toString('base64');
    this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    this.ps.on('error', () => { this.ps = null; });
    this.ps.stdin.on('error', () => {});
  }

  add(pid) {
    if (this.ps && pid) this.ps.stdin.write(`${pid}\n`);
  }

  stop() {
    if (this.ps) { try { this.ps.stdin.end(); this.ps.kill(); } catch {} this.ps = null; }
  }
}

module.exports = { CpuLimiter };
