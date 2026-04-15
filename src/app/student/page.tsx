"use client";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, AlertOctagon, ShieldAlert } from "lucide-react";
import ActiveSessionModal from "@/components/ActiveSessionModal";
import { db } from "@/lib/firebase";
import { getAuth } from "firebase/auth";
import { useAuthState } from "react-firebase-hooks/auth";
import { doc, collection, onSnapshot, query, where, limit, collectionGroup, getDoc, setDoc, getDocs, serverTimestamp } from "firebase/firestore";

const COURSE_ID = "CSE203";
const TOTAL_REQUIRED_PERCENTAGE = 0.75;
const TOTAL_SESSIONS = 26;

export default function StudentDashboard() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const auth = getAuth();
  const [user] = useAuthState(auth);
  const [mounted, setMounted] = useState(false);
  
  // Auth & User State
  const [studentRollNo, setStudentRollNo] = useState<string | null>(null);
  const [idToken, setIdToken] = useState<string>("");

  // --- FIRST-CLAIM PROTOCOL STATES ---
  const [officialRollNo, setOfficialRollNo] = useState<string | null>(null);
  const [showRegistration, setShowRegistration] = useState(false);
  const [claimInput, setClaimInput] = useState("");
  const [claimError, setClaimError] = useState("");

  // 1. INVISIBLE IDENTITY CHECK
  useEffect(() => {
    const checkIdentity = async () => {
      // Wait until we know who is logged in
      if (!user?.email) return;

      try {
        // Look up their email in our secure directory
        const userDocRef = doc(db, "student_directory", user.email);
        const userDoc = await getDoc(userDocRef);

        if (userDoc.exists()) {
          // Identity verified! Load their AU number securely into memory
          setOfficialRollNo(userDoc.data().rollNo);
        } else {
          // No identity found. Lock the screen and trigger the First-Claim pop-up
          setShowRegistration(true);
        }
      } catch (error) {
        console.error("Error checking identity:", error);
      }
    };

    checkIdentity();
  }, [user]);

  // Session State
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  
  // Dynamic Stats State
  const [totalConducted, setTotalConducted] = useState(0);
  const [attended, setAttended] = useState(0);

  // 1. Hydration fix for Dark Mode
  useEffect(() => {
    setMounted(true);
  }, []);

  // 2. Domain Restriction & Token Fetch
  useEffect(() => {
    const verifyDomainAndToken = async () => {
      if (user && user.email) {
        // Kick out anyone not using a university email
        if (!user.email.endsWith("@ahduni.edu.in")) {
          router.push("/");
          return;
        }
        
        // Grab the secure token for your database submissions
        const token = await user.getIdToken();
        setIdToken(token);
      }
    };
    verifyDomainAndToken();
  }, [user, router]);

  useEffect(() => {
    if (!studentRollNo) return;

    // 2. DYNAMIC STATS: Listen to Course Total
    const courseUnsub = onSnapshot(doc(db, `courses/${COURSE_ID}`), (docSnap) => {
      if (docSnap.exists()) {
        setTotalConducted(docSnap.data().totalSessionsConducted || 0);
      }
    });

    // 3. DYNAMIC STATS: Collection Group Query for Student's Attendance
    // NOTE: Requires a Firestore Index on 'submissions' collection group for 'rollNo'
    const statsQuery = query(collectionGroup(db, 'submissions'), where('rollNo', '==', studentRollNo));
    const statsUnsub = onSnapshot(statsQuery, (snapshot) => {
      setAttended(snapshot.size);
    });

    // 4. ACTIVE SESSION LISTENER: Find any currently active session
    const sessionQuery = query(collection(db, `courses/${COURSE_ID}/sessions`), where('session_active', '==', true), limit(1));
    const sessionUnsub = onSnapshot(sessionQuery, (snapshot) => {
      if (!snapshot.empty) {
        setActiveSessionId(snapshot.docs[0].id);
        setIsSessionActive(true);
      } else {
        setIsSessionActive(false);
      }
    });

    return () => {
      courseUnsub();
      statsUnsub();
      sessionUnsub();
    };
  }, [studentRollNo]);

  // Calculations
  const holidaysTaken = totalConducted - attended;
  const maxAllowedHolidays = Math.floor(TOTAL_SESSIONS * (1 - TOTAL_REQUIRED_PERCENTAGE));
  
  const getHolidayColor = (holidays: number, max: number) => {
    if (max === 0) return "text-success";
    const ratio = holidays / max;
    if (ratio <= 0.5) return "text-success";
    if (ratio <= 0.8) return "text-warning";
    return "text-danger";
  };

  if (!mounted) return null;

  if (!studentRollNo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-textPrimary">
        <div className="animate-pulse flex flex-col items-center">
          <ShieldAlert className="w-12 h-12 text-accentRed mb-4" />
          <p>Authenticating via University SSO...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-textPrimary p-6 md:p-12 transition-colors duration-300">
      
      {isSessionActive && (
        <ActiveSessionModal 
          courseId={COURSE_ID}
          date={activeSessionId} // Passing the unique timestamp ID to the API route
          studentRollNo={studentRollNo}
          idToken={idToken}
          onClose={() => setIsSessionActive(false)}
        />
      )}

      <header className="flex justify-between items-center mb-10 border-b border-textSecondary/20 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Student Portal</h1>
          <p className="text-textSecondary font-mono mt-1">{studentRollNo}</p>
        </div>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="p-3 rounded-full bg-surface border border-textSecondary/20 hover:border-accentRed transition-colors">
          {theme === "dark" ? <Sun className="w-5 h-5 text-warning" /> : <Moon className="w-5 h-5 text-textPrimary" />}
        </button>
      </header>

      <main className="max-w-4xl mx-auto space-y-8">
        <div className="bg-surface border-l-4 border-accentRed p-6 rounded-r-lg shadow-md">
          <h2 className="text-2xl font-bold">{COURSE_ID} - Object Oriented Programming</h2>
          <p className="text-textSecondary">Section 2 • TA: Shashwat.G</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-surface p-6 rounded-xl border border-textSecondary/10 shadow-sm">
            <p className="text-textSecondary text-sm uppercase tracking-wider mb-2">Total Conducted</p>
            <p className="text-4xl font-bold">{totalConducted}</p>
          </div>
          
          <div className="bg-surface p-6 rounded-xl border border-textSecondary/10 shadow-sm">
            <p className="text-textSecondary text-sm uppercase tracking-wider mb-2">Attended</p>
            <p className="text-4xl font-bold text-success">{attended}</p>
          </div>

          <div className="bg-surface p-6 rounded-xl border border-textSecondary/10 shadow-sm flex flex-col justify-between">
            <div>
              <p className="text-textSecondary text-sm uppercase tracking-wider mb-2">Holidays Taken</p>
              <p className={`text-4xl font-bold ${getHolidayColor(holidaysTaken, maxAllowedHolidays)}`}>
                {holidaysTaken} <span className="text-lg text-textSecondary font-normal">/ {maxAllowedHolidays} Max</span>
              </p>
            </div>
            
            {holidaysTaken === maxAllowedHolidays && maxAllowedHolidays > 0 && (
              <div className="mt-4 bg-warning/20 p-3 rounded flex items-start border border-warning/30">
                <AlertOctagon className="w-5 h-5 text-warning mr-2 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-warning font-medium leading-tight">Danger: Missing next class drops you below 75%.</p>
              </div>
            )}
            {holidaysTaken > maxAllowedHolidays && (
              <div className="mt-4 bg-danger/20 p-3 rounded flex items-start border border-danger/30">
                <ShieldAlert className="w-5 h-5 text-danger mr-2 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-danger font-medium leading-tight">CRITICAL: Attendance threshold breached.</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}