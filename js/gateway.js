// Gateway & Role Switcher Logic with Per-Device Independent Lockout & Remote Admin Unlocking
import { 
  db, 
  doc, 
  setDoc, 
  onSnapshot, 
  serverTimestamp 
} from "./firebase-config.js";

const MAX_SUPERVISOR_ATTEMPTS = 2;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes cooldown lockout
const EMERGENCY_UNLOCK_PIN = '998877';
const SECURITY_LOGS_KEY = 'SCHOOL_SECURITY_LOGS';

// Device type helper
export function detectDeviceType() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('android')) return 'هاتف أندرويد (Android)';
  if (ua.includes('iphone')) return 'هاتف آيفون (iPhone)';
  if (ua.includes('ipad')) return 'جهاز آيباد (iPad)';
  if (ua.includes('windows')) return 'كمبيوتر ويندوز (Windows)';
  if (ua.includes('macintosh') || ua.includes('mac os')) return 'كمبيوتر ماك (Mac)';
  return 'جهاز متصفح';
}

// Generate or retrieve persistent unique Device ID for this device/browser
export function getDeviceId() {
  let deviceId = localStorage.getItem('school_device_id');
  if (!deviceId) {
    deviceId = 'DEV-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    localStorage.setItem('school_device_id', deviceId);
  }
  return deviceId;
}

const currentDeviceId = getDeviceId();
const FAILED_ATTEMPTS_KEY = `supervisor_failed_attempts_${currentDeviceId}`;
const LOCKED_KEY = `supervisor_portal_locked_${currentDeviceId}`;
const LOCK_EXPIRE_KEY = `supervisor_lock_expire_${currentDeviceId}`;

let countdownInterval = null;

// Save attempt log to localStorage and Firestore
async function recordSecurityAttempt(attempts, isLocked) {
  const timestamp = new Date().toISOString();
  const timeFormatted = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateFormatted = new Date().toLocaleDateString('ar-EG', { year: 'numeric', month: 'numeric', day: 'numeric' });

  const logEntry = {
    deviceId: currentDeviceId,
    deviceType: detectDeviceType(),
    attempts: attempts,
    isLocked: isLocked,
    status: isLocked ? 'locked' : 'warning',
    lastAttemptAt: timestamp,
    timeFormatted: `${dateFormatted} - ${timeFormatted}`
  };

  // 1. Save locally
  try {
    const raw = localStorage.getItem(SECURITY_LOGS_KEY);
    let logs = raw ? JSON.parse(raw) : [];
    // Update existing device entry or prepend
    logs = logs.filter(l => l.deviceId !== currentDeviceId);
    logs.unshift(logEntry);
    localStorage.setItem(SECURITY_LOGS_KEY, JSON.stringify(logs));
  } catch (e) {
    console.warn("Local security log note:", e);
  }

  // 2. Sync to Firebase Firestore so supervisor sees it in real-time
  try {
    await setDoc(doc(db, "device_security", currentDeviceId), {
      ...logEntry,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.warn("Firestore security log notice:", err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Display current Device ID on screen
  const deviceBadge = document.getElementById('currentDeviceIdText');
  const lockedDeviceBadge = document.getElementById('lockedDeviceIdText');
  if (deviceBadge) deviceBadge.innerText = currentDeviceId;
  if (lockedDeviceBadge) lockedDeviceBadge.innerText = currentDeviceId;

  // Setup automatic focus stepping for 6 PIN inputs
  const boxes = document.querySelectorAll('.pin-box');
  boxes.forEach((input, index) => {
    input.addEventListener('input', (e) => {
      if (e.target.value.length === 1 && index < boxes.length - 1) {
        boxes[index + 1].focus();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && index > 0) {
        boxes[index - 1].focus();
      } else if (e.key === 'Enter') {
        verifySupervisorPIN();
      }
    });
  });

  // Check if THIS specific device is currently locked
  checkDeviceLockoutState();

  // Listen for remote unblock commands from the Teacher Dashboard (via Firestore)
  try {
    onSnapshot(doc(db, "device_security", currentDeviceId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.status === 'unblocked' || data.isLocked === false) {
          if (localStorage.getItem(LOCKED_KEY) === 'true') {
            console.log("Remote unblock received from supervisor!");
            unlockThisDevice(true);
          }
        }
      }
    }, (err) => console.warn("Remote unblock listener notice:", err));
  } catch (e) {
    console.warn("Firestore remote unblock init note:", e);
  }

  // Also listen for local storage cross-tab unblock
  window.addEventListener('storage', (e) => {
    if (e.key === SECURITY_LOGS_KEY || e.key === LOCKED_KEY) {
      if (localStorage.getItem(LOCKED_KEY) !== 'true') {
        unlockThisDevice(true);
      }
    }
  });
});

// Check if this device is locked or if lockout timer expired
function checkDeviceLockoutState() {
  const isLocked = localStorage.getItem(LOCKED_KEY) === 'true';
  const expireTime = Number(localStorage.getItem(LOCK_EXPIRE_KEY) || 0);

  if (isLocked) {
    const now = Date.now();
    if (expireTime && now >= expireTime) {
      // Cooldown expired! Auto-unlock this device
      unlockThisDevice();
    } else {
      // Still locked
      lockSupervisorPortal(expireTime);
    }
  }
}

// Student navigation
window.handleStudentEntry = function() {
  const toast = document.getElementById('notice-toast');
  const toastMsg = document.getElementById('toast-message');
  const toastIcon = document.getElementById('toast-icon');
  
  if (toast && toastMsg && toastIcon) {
    toastMsg.innerText = 'جاري توجيهك لشاشة الاستعلام برقم الجلوس...';
    toastIcon.innerText = 'manage_search';
    toast.classList.remove('hidden');
  }
  
  setTimeout(() => {
    window.location.href = 'student-results.html';
  }, 400);
};

// Toggle password visibility (show / hide dots)
window.togglePinVisibility = function() {
  const boxes = document.querySelectorAll('.pin-box');
  const icon = document.getElementById('pinEyeIcon');
  const text = document.getElementById('pinEyeText');

  if (boxes.length === 0) return;

  const isCurrentPassword = boxes[0].type === 'password';
  const newType = isCurrentPassword ? 'text' : 'password';

  boxes.forEach(box => box.type = newType);

  if (icon) {
    icon.innerText = isCurrentPassword ? 'visibility_off' : 'visibility';
  }
  if (text) {
    text.innerText = isCurrentPassword ? 'إخفاء الرمز' : 'إظهار الرمز';
  }
};

// Verify supervisor PIN with device-specific tracking
window.verifySupervisorPIN = function() {
  // If this device is locked, block action
  if (localStorage.getItem(LOCKED_KEY) === 'true') {
    checkDeviceLockoutState();
    return;
  }

  const boxes = document.querySelectorAll('.pin-box');
  let enteredCode = '';
  boxes.forEach(box => enteredCode += box.value.trim());

  const feedback = document.getElementById('pin-feedback');
  const feedbackMsg = document.getElementById('pin-feedback-msg');
  const toast = document.getElementById('notice-toast');
  const toastMsg = document.getElementById('toast-message');
  const toastIcon = document.getElementById('toast-icon');

  // Validate complete 6-digit entry
  if (enteredCode.length < 6) {
    if (feedback && feedbackMsg) {
      feedback.classList.remove('hidden');
      feedbackMsg.innerText = 'يرجى إدخال كود المرور كاملاً (6 أرقام).';
    }
    boxes.forEach(b => {
      b.classList.add('border-error');
      setTimeout(() => b.classList.remove('border-error'), 1200);
    });
    return;
  }

  // Check correct PIN (350927)
  if (enteredCode === '350927') {
    // Reset failed attempts on this device
    localStorage.removeItem(FAILED_ATTEMPTS_KEY);
    localStorage.removeItem(LOCKED_KEY);
    localStorage.removeItem(LOCK_EXPIRE_KEY);

    if (feedback) feedback.classList.add('hidden');
    if (toast && toastMsg && toastIcon) {
      toastMsg.innerText = 'تم التحقق من هوية المعلم المشرف بنجاح. جاري فتح لوحة الكنترول...';
      toastIcon.innerText = 'lock_open';
      toast.classList.remove('hidden');
    }
    
    // Set authenticated session flag for this browser tab
    sessionStorage.setItem('supervisor_auth', 'true');
    sessionStorage.setItem('supervisor_device_id', currentDeviceId);

    setTimeout(() => {
      window.location.href = 'teacher-dashboard.html';
    }, 600);

  } else {
    // Increment failed attempts for THIS SPECIFIC DEVICE only
    let currentAttempts = Number(localStorage.getItem(FAILED_ATTEMPTS_KEY) || 0) + 1;
    localStorage.setItem(FAILED_ATTEMPTS_KEY, currentAttempts);

    // Clear entered boxes
    boxes.forEach(box => {
      box.value = '';
      box.classList.add('bg-error-container', 'border-error');
      setTimeout(() => box.classList.remove('bg-error-container', 'border-error'), 1000);
    });
    boxes[0]?.focus();

    const isLocked = currentAttempts >= MAX_SUPERVISOR_ATTEMPTS;

    // Send security alert log to supervisor dashboard
    recordSecurityAttempt(currentAttempts, isLocked);

    if (isLocked) {
      // Lock out THIS device only
      const expireTime = Date.now() + LOCKOUT_DURATION_MS;
      localStorage.setItem(LOCKED_KEY, 'true');
      localStorage.setItem(LOCK_EXPIRE_KEY, expireTime);
      lockSupervisorPortal(expireTime);
    } else {
      // 1st failed attempt warning on this device
      const remaining = MAX_SUPERVISOR_ATTEMPTS - currentAttempts;
      if (feedback && feedbackMsg) {
        feedback.classList.remove('hidden');
        feedbackMsg.innerText = `⚠️ كود المرور غير صحيح على هذا الجهاز! متبقي لك محاولة أخيرة (${remaining} من ${MAX_SUPERVISOR_ATTEMPTS}).`;
      }
    }
  }
};

// Lock down the supervisor entry on this device with live timer
function lockSupervisorPortal(expireTime) {
  const pinInputGroup = document.getElementById('pinInputGroup');
  const lockoutNotice = document.getElementById('supervisorLockoutNotice');
  const submitBtn = document.getElementById('supervisorSubmitBtn');
  const pinFeedback = document.getElementById('pin-feedback');
  const timerDisplay = document.getElementById('lockTimerDisplay');

  if (pinFeedback) pinFeedback.classList.add('hidden');
  if (pinInputGroup) pinInputGroup.classList.add('hidden');
  if (lockoutNotice) lockoutNotice.classList.remove('hidden');

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.className = 'w-full h-12 bg-gray-400 text-white font-bold text-sm rounded-xl shadow-none flex items-center justify-center gap-2 cursor-not-allowed opacity-80';
    submitBtn.innerHTML = '<span class="material-symbols-outlined text-lg">lock_person</span><span>بوابة المشرف مغلقة على هذا الجهاز</span>';
  }

  // Live countdown timer for lockout expiration
  if (countdownInterval) clearInterval(countdownInterval);

  function updateTimer() {
    const remainingMs = expireTime - Date.now();
    if (remainingMs <= 0) {
      clearInterval(countdownInterval);
      unlockThisDevice();
      return;
    }

    const totalSeconds = Math.floor(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (timerDisplay) {
      timerDisplay.innerText = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    }
  }

  updateTimer();
  countdownInterval = setInterval(updateTimer, 1000);
}

// Unlock this device (called locally or remotely by the supervisor)
window.unlockThisDevice = function(isRemote = false) {
  if (countdownInterval) clearInterval(countdownInterval);
  localStorage.removeItem(FAILED_ATTEMPTS_KEY);
  localStorage.removeItem(LOCKED_KEY);
  localStorage.removeItem(LOCK_EXPIRE_KEY);

  const pinInputGroup = document.getElementById('pinInputGroup');
  const lockoutNotice = document.getElementById('supervisorLockoutNotice');
  const submitBtn = document.getElementById('supervisorSubmitBtn');
  const emergencyBox = document.getElementById('emergencyUnlockBox');

  if (emergencyBox) emergencyBox.classList.add('hidden');
  if (lockoutNotice) lockoutNotice.classList.add('hidden');
  if (pinInputGroup) pinInputGroup.classList.remove('hidden');

  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.className = 'w-full h-12 bg-secondary hover:bg-secondary/90 text-on-secondary font-bold text-sm rounded-xl shadow-sm flex items-center justify-center gap-2 transition-all active:scale-[0.99] cursor-pointer';
    submitBtn.innerHTML = '<span class="material-symbols-outlined text-lg">key</span><span>تسجيل الدخول كمعلم مشرف</span>';
  }

  const boxes = document.querySelectorAll('.pin-box');
  boxes.forEach(box => box.value = '');
  boxes[0]?.focus();

  if (isRemote) {
    const feedback = document.getElementById('pin-feedback');
    const feedbackMsg = document.getElementById('pin-feedback-msg');
    if (feedback && feedbackMsg) {
      feedback.classList.remove('hidden');
      feedback.className = 'h-6 flex items-center justify-start text-xs text-emerald-700 font-bold';
      feedbackMsg.innerText = '✅ قام المعلم المشرف بفك الحظر عن جهازك! يمكنك المحاولة الآن.';
      setTimeout(() => feedback.classList.add('hidden'), 5000);
    }
  }
};

// Emergency / Admin recovery unlock
window.toggleEmergencyUnlock = function() {
  const box = document.getElementById('emergencyUnlockBox');
  if (box) {
    box.classList.toggle('hidden');
    document.getElementById('emergencyUnlockInput')?.focus();
  }
};

window.submitEmergencyUnlock = function() {
  const input = document.getElementById('emergencyUnlockInput');
  const code = input ? input.value.trim() : '';

  if (code === EMERGENCY_UNLOCK_PIN) {
    alert('✅ تم التحقق من كود الإدارة وفك حظر هذا الجهاز بنجاح!');
    unlockThisDevice();
  } else {
    alert('❌ كود استعادة الإدارة غير صحيح!');
    if (input) input.value = '';
  }
};

window.hideToast = function() {
  const toast = document.getElementById('notice-toast');
  if (toast) toast.classList.add('hidden');
};
