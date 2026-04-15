"use client";

import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, QrCode, Hash, Users, ShieldAlert, Download, UserPlus, Clock, CheckCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { db } from "@/lib/firebase";
import { getAuth } from "firebase/auth";
import { useAuthState } from "react-firebase-hooks/auth";
import { 
  doc, collection, onSnapshot, serverTimestamp, 
  writeBatch, increment, getDocs, query, orderBy 
} from "firebase/firestore";

const COURSE_ID = "CSE203";
const TOTAL_ENROLLED = 60;

async function generateClientTOTP(secret: string, timeWindow: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await window.crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await window.crypto.subtle.sign("HMAC", key, enc.encode(timeWindow.toString()));
  const hashArray = Array.from(new Uint8Array(signature));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return (parseInt(hashHex.substring(0, 8), 16) % 10000).toString().padStart(4, '0');
}

export default function TADashboard() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // 1. Listen for the logged-in user
  const auth = getAuth();
  const [user, loading] = useAuthState(auth);

  // 2. THE VIP LIST (Replace with actual emails!)
  const AUTHORIZED_TAS = [
    "devesh.c@ahduni.edu.in",
    "jainil.something@ahduni.edu.in", 
    "yash.something@ahduni.edu.in"
  ];

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [timeLeft, setTimeLeft] = useState(60);
  const [displayMode, setDisplayMode] = useState<"OTP" | "QR">("OTP");
  const [currentOtp, setCurrentOtp] = useState("----");
  const [sessionSecret, setSessionSecret] = useState<string | null>(null);
  
  const [presentCount, setPresentCount] = useState(0);
  const [presentStudents, setPresentStudents] = useState<any[]>([]);
  const [manualRollNo, setManualRollNo] = useState("");
  const [overrideLog, setOverrideLog] = useState<string[]>([]);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => setMounted(true), []);

  // 1. START SESSION (Batch Write: Create Session + Increment Course Total)
  const handleStartSession = async () => {
    const secret = Math.random().toString(36).substring(2, 15);
    const newSessionId = Date.now().toString(); // Unique ID fixes ghost data
    
    try {
      const batch = writeBatch(db);
      
      // Create Session Doc
      const sessionRef = doc(db, `courses/${COURSE_ID}/sessions/${newSessionId}`);
      batch.set(sessionRef, {
        session_active: true,
        startTime: serverTimestamp(),
        otpSecret: secret,
        dateString: new Date().toLocaleString()
      });

      // Increment Total Sessions in Course Doc
      const courseRef = doc(db, `courses/${COURSE_ID}`);
      batch.set(courseRef, { totalSessionsConducted: increment(1) }, { merge: true });

      await batch.commit();
      
      setSessionSecret(secret);
      setActiveSessionId(newSessionId);
      setIsSessionActive(true);
      setTimeLeft(60);
    } catch (error) {
      console.error("Failed to start session:", error);
      alert("Database Error: Ensure Firestore rules allow TA writes.");
    }
  };

  // 2. MASTER COUNTDOWN & TOTP SYNC
  useEffect(() => {
    let timerInterval: NodeJS.Timeout;
    let otpInterval: NodeJS.Timeout;

    if (isSessionActive && sessionSecret && activeSessionId) {
      timerInterval = setInterval(async () => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            // End Session
            const batch = writeBatch(db);
            batch.update(doc(db, `courses/${COURSE_ID}/sessions/${activeSessionId}`), { session_active: false });
            batch.commit();
            setIsSessionActive(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      const updateDisplayOtp = async () => {
        const currentWindow = Math.floor(Date.now() / 10000);
        const otp = await generateClientTOTP(sessionSecret, currentWindow);
        setCurrentOtp(otp);
      };
      
      updateDisplayOtp();
      otpInterval = setInterval(updateDisplayOtp, 10000);

      return () => {
        clearInterval(timerInterval);
        clearInterval(otpInterval);
      };
    }
  }, [isSessionActive, sessionSecret, activeSessionId]);

  // 3. LIVE REALITY CHECK (Listens to current active session)
  useEffect(() => {
    if (!isSessionActive || !activeSessionId) return;

    const submissionsRef = collection(db, `courses/${COURSE_ID}/sessions/${activeSessionId}/submissions`);
    const unsubscribe = onSnapshot(submissionsRef, (snapshot) => {
      setPresentCount(snapshot.size);
      const students = snapshot.docs.map(doc => ({
        rollNo: doc.id,
        method: doc.data().method,
        time: doc.data().timestamp?.toDate().toLocaleTimeString() || "Just now"
      }));
      setPresentStudents(students);
    });

    return () => unsubscribe();
  }, [isSessionActive, activeSessionId]);

  // 4. MANUAL OVERRIDE (Batch Write: Submission + Permanent Audit Log)
  const handleManualOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualRollNo.trim() || !activeSessionId) return;

    const roll = manualRollNo.toUpperCase();
    try {
      const batch = writeBatch(db);
      
      // Write to Session Submissions
      const subRef = doc(db, `courses/${COURSE_ID}/sessions/${activeSessionId}/submissions/${roll}`);
      batch.set(subRef, {
        rollNo: roll, // Required for Student Collection Group Query
        status: 'Present',
        method: 'Manual Override',
        timestamp: serverTimestamp(),
        deviceHash: 'TA_OVERRIDE',
        ipAddress: 'TA_OVERRIDE'
      });

      // Write to Permanent Audit Log
      const auditRef = doc(collection(db, `courses/${COURSE_ID}/audit_logs`));
      batch.set(auditRef, {
        rollNo: roll,
        sessionId: activeSessionId,
        action: 'Manual Override',
        timestamp: serverTimestamp()
      });
      
      await batch.commit();
      setOverrideLog(prev => [`[${new Date().toLocaleTimeString()}] Overrode attendance for ${roll}`, ...prev]);
      setManualRollNo("");
    } catch (error) {
      console.error("Override failed:", error);
    }
  };

  // 5. MASTER CSV EXPORT (Traverses entire DB tree)
  const handleMasterExportCSV = async () => {
    setIsExporting(true);
    try {
      const sessionsSnap = await getDocs(query(collection(db, `courses/${COURSE_ID}/sessions`), orderBy("startTime", "desc")));
      
      let csvContent = "Date,Session ID,Roll Number,Method,Timestamp\n";
      
      for (const sessionDoc of sessionsSnap.docs) {
        const sData = sessionDoc.data();
        const sDate = sData.dateString || "Unknown Date";
        const sId = sessionDoc.id;
        
        const subsSnap = await getDocs(collection(db, `courses/${COURSE_ID}/sessions/${sId}/submissions`));
        subsSnap.forEach(sub => {
          const subData = sub.data();
          const time = subData.timestamp?.toDate().toLocaleString() || "N/A";
          csvContent += `"${sDate}","${sId}","${sub.id}","${subData.method}","${time}"\n`;
        });
      }
      
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${COURSE_ID}_Master_Attendance_Export.csv`;
      link.click();
    } catch (error) {
      console.error("Export failed:", error);
      alert("Failed to generate master export.");
    }
    setIsExporting(false);
  };
// 3. THE BOUNCER (Locks the page if not on the VIP list)
  if (!loading && (!user || !AUTHORIZED_TAS.includes(user.email || ""))) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background p-4">
        <div className="p-8 bg-surface border-2 border-accentRed/50 rounded-xl shadow-2xl text-center max-w-md w-full">
          <h2 className="text-2xl font-bold text-accentRed mb-2 uppercase tracking-wider">Access Restricted</h2>
          <div className="h-1 w-16 bg-accentRed mx-auto mb-4 rounded-full"></div>
          <p className="text-textSecondary font-medium">
            You do not have administrative privileges. 
          </p>
          <p className="text-sm text-textSecondary/70 mt-4">
            Only authorized Teaching Assistants can access this secure portal. Your attempt has been logged.
          </p>
          <button 
            onClick={() => window.location.href = '/'}
            className="mt-8 w-full bg-background border border-textSecondary hover:border-textPrimary text-textPrimary py-3 rounded-lg transition-colors"
          >
            Return to Home
          </button>
        </div>
      </div>
    );
  }
  if (!mounted) return null;

  return (
    <div className="min-h-screen bg-background text-textPrimary p-6 md:p-12 transition-colors duration-300">
      <header className="flex justify-between items-center mb-10 border-b border-textSecondary/20 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">TA Dashboard</h1>
          <p className="text-textSecondary font-mono mt-1">{COURSE_ID} - Section 1</p>
          {/* Dynamic Header Enhancement */}
          <p className="text-accentRed text-sm font-bold mt-2">{new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        </div>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="p-3 rounded-full bg-surface border border-textSecondary/20 hover:border-accentRed transition-colors">
          {theme === "dark" ? <Sun className="w-5 h-5 text-warning" /> : <Moon className="w-5 h-5 text-textPrimary" />}
        </button>
      </header>

      <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* LEFT COLUMN: Session Control */}
        <div className="lg:col-span-2 space-y-8">
          <div className={`relative overflow-hidden rounded-2xl border-2 transition-all duration-500 ${isSessionActive ? 'border-accentRed shadow-[0_0_40px_rgba(255,0,51,0.15)] bg-surface' : 'border-textSecondary/20 bg-surface'}`}>
            {!isSessionActive ? (
              <div className="p-12 flex flex-col items-center justify-center text-center min-h-[400px]">
                <ShieldAlert className="w-16 h-16 text-textSecondary mb-4" />
                <h2 className="text-2xl font-bold mb-2">No Active Session</h2>
                <button onClick={handleStartSession} className="bg-accentRed hover:bg-accentRed/80 text-white font-bold py-4 px-8 rounded-lg text-xl transition-colors shadow-lg mt-6">
                  START 60s SESSION
                </button>
              </div>
            ) : (
              <div className="p-8 md:p-12 flex flex-col items-center text-center min-h-[400px]">
                <div className="absolute top-6 right-6 flex items-center bg-background px-4 py-2 rounded-full border border-accentRed/50">
                  <Clock className="w-5 h-5 text-accentRed mr-2 animate-pulse" />
                  <span className="text-2xl font-mono font-bold text-accentRed">{timeLeft}s</span>
                </div>

                <div className="flex space-x-4 mb-8 bg-background p-1 rounded-lg border border-textSecondary/20">
                  <button onClick={() => setDisplayMode("OTP")} className={`flex items-center px-6 py-2 rounded-md font-bold transition-colors ${displayMode === "OTP" ? 'bg-surface text-accentRed shadow' : 'text-textSecondary hover:text-textPrimary'}`}><Hash className="w-4 h-4 mr-2" /> OTP</button>
                  <button onClick={() => setDisplayMode("QR")} className={`flex items-center px-6 py-2 rounded-md font-bold transition-colors ${displayMode === "QR" ? 'bg-surface text-accentRed shadow' : 'text-textSecondary hover:text-textPrimary'}`}><QrCode className="w-4 h-4 mr-2" /> QR CODE</button>
                </div>

                <div className="flex-1 flex flex-col items-center justify-center w-full">
                  {displayMode === "OTP" ? (
                    <div className="text-[8rem] leading-none font-mono font-black tracking-[0.2em] text-textPrimary drop-shadow-[0_0_15px_rgba(255,255,255,0.2)]">{currentOtp}</div>
                  ) : (
                    <div className="w-64 h-64 bg-white p-4 rounded-xl flex items-center justify-center border-4 border-accentRed">
                      <QRCodeSVG value={currentOtp} size={224} className="w-full h-full" />
                    </div>
                  )}
                  <div className="w-64 h-1 bg-background mt-8 rounded-full overflow-hidden">
                    <div className="h-full bg-accentRed transition-all duration-1000 ease-linear" style={{ width: `${((timeLeft % 10) / 10) * 100}%` }} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: Management */}
        <div className="space-y-6">
          <div className="bg-surface p-6 rounded-xl border border-textSecondary/20 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold uppercase tracking-wider flex items-center"><Users className="w-5 h-5 mr-2 text-accentRed" /> Reality Check</h3>
              {isSessionActive && <span className="flex h-3 w-3 rounded-full bg-success animate-ping" />}
            </div>
            <div className="flex items-baseline space-x-2">
              <span className={`text-6xl font-black ${presentCount > TOTAL_ENROLLED ? 'text-danger' : 'text-textPrimary'}`}>{presentCount}</span>
              <span className="text-2xl text-textSecondary font-medium">/ {TOTAL_ENROLLED}</span>
            </div>
          </div>

          <div className="bg-surface p-6 rounded-xl border border-textSecondary/20 shadow-sm">
            <h3 className="text-lg font-bold mb-4 flex items-center"><UserPlus className="w-5 h-5 mr-2 text-warning" /> Manual Override</h3>
            <form onSubmit={handleManualOverride} className="space-y-3">
              <input type="text" placeholder="Enter Roll No (e.g. AU2540...)" value={manualRollNo} onChange={(e) => setManualRollNo(e.target.value)} className="w-full bg-background border border-textSecondary/30 rounded-lg px-4 py-3 text-textPrimary focus:outline-none focus:border-warning focus:ring-1 focus:ring-warning transition-all uppercase" />
              <button type="submit" disabled={!manualRollNo.trim() || !isSessionActive} className="w-full bg-background border border-warning text-warning hover:bg-warning hover:text-background font-bold py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">Force Present</button>
            </form>
          </div>

          <div className="bg-surface p-6 rounded-xl border border-textSecondary/20 shadow-sm">
            <h3 className="text-lg font-bold mb-4 flex items-center"><CheckCircle className="w-5 h-5 mr-2 text-success" /> Post-Session Actions</h3>
            <button onClick={handleMasterExportCSV} disabled={isSessionActive || isExporting} className="w-full flex items-center justify-center bg-background border border-success text-success hover:bg-success hover:text-background font-bold py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              <Download className="w-5 h-5 mr-2" /> {isExporting ? "Compiling Data..." : "Master Export (CSV)"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}