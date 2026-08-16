import { useState, useEffect, useRef } from "react";
import { login, register, changePin, requestPinReset, confirmPinReset } from "../../api.js";
import { t, detectGuestLang } from "../../lib/i18n.js";
import { labelStyle, inputStyle } from "../../components/ui/styles.js";
import { PinDots, NumPad } from "../../components/ui/PinInput.jsx";

export function LoginScreen({ onLogin }) {
  const [lang] = useState(() => detectGuestLang());
  const [mode, setMode] = useState("login"); // "login" | "register" | "change-pin"

  // Login state — numpad
  const [pin, setPin] = useState("");
  const [loginErrore, setLoginErrore] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [pinShake, setPinShake] = useState(false);
  const PIN_LEN = 6; // lunghezza minima di riferimento per i puntini (non aziona più l'auto-submit)

  // Register state
  const [regNome, setRegNome] = useState("");
  const [regPersone, setRegPersone] = useState([{ nome: "", emoji: "😀" }, { nome: "", emoji: "😊" }]);
  const [regPin, setRegPin] = useState("");
  const [regPinConferma, setRegPinConferma] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regErrore, setRegErrore] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regSuccesso, setRegSuccesso] = useState(false);
  const [emojiPickerIdx, setEmojiPickerIdx] = useState(null); // which persona's picker is open

  // Forgot-PIN state: "email" (chiedi indirizzo) → "code" (codice + nuovo PIN)
  const [forgotStep, setForgotStep] = useState(null); // null | "email" | "code"
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotCode, setForgotCode] = useState("");
  const [forgotNewPin, setForgotNewPin] = useState("");
  const [forgotNewPinConferma, setForgotNewPinConferma] = useState("");
  const [forgotErrore, setForgotErrore] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMsg, setForgotMsg] = useState("");

  const [loginFromCache, setLoginFromCache] = useState(false);
  const [loginSubtitle, setLoginSubtitle] = useState("");

  // PIN change state
  const [newPin, setNewPin] = useState("");
  const [newPinConferma, setNewPinConferma] = useState("");
  const [changePinStep, setChangePinStep] = useState("new"); // "new" | "confirm"
  const [changePinErrore, setChangePinErrore] = useState("");
  const [changePinLoading, setChangePinLoading] = useState(false);

  async function handleChangePinDigit(d) {
    if (changePinStep === "new") {
      const val = newPin + d;
      if (val.length <= 8) setNewPin(val);
    } else {
      const val = newPinConferma + d;
      if (val.length <= 8) setNewPinConferma(val);
    }
  }
  function handleChangePinDelete() {
    if (changePinStep === "new") setNewPin(p => p.slice(0, -1));
    else setNewPinConferma(p => p.slice(0, -1));
  }
  async function handleChangePinNext() {
    if (changePinStep === "new") {
      if (newPin.length < 6) return setChangePinErrore(t(lang, "login.pinMin6"));
      setChangePinErrore("");
      setChangePinStep("confirm");
    } else {
      if (newPin !== newPinConferma) {
        setChangePinErrore(t(lang, "login.pinMismatch"));
        setNewPinConferma("");
        return;
      }
      setChangePinLoading(true);
      setChangePinErrore("");
      try {
        await changePin(newPin);
        onLogin();
      } catch (err) {
        setChangePinErrore(err.message || t(lang, "login.errorUpdatePin"));
        setNewPin(""); setNewPinConferma(""); setChangePinStep("new");
      } finally {
        setChangePinLoading(false);
      }
    }
  }

  const submitRef = useRef(null);
  submitRef.current = async (p) => {
    setLoginLoading(true); setLoginErrore(""); setLoginFromCache(false); setLoginSubtitle("");

    // Show "server waking up" hint after 4s if still loading
    const hintTimer = setTimeout(() => {
      setLoginSubtitle(t(lang, "login.serverWakingUp"));
    }, 4000);

    try {
      const result = await login(p);
      if (result._fromCache) setLoginFromCache(true);
      if (result.requiresPinChange) {
        setMode("change-pin");
      } else {
        onLogin();
      }
    }
    catch (err) {
      setLoginErrore(err.message || t(lang, "login.invalidPin"));
      setPinShake(true);
      setTimeout(() => { setPinShake(false); setPin(""); }, 450);
    }
    finally {
      clearTimeout(hintTimer);
      setLoginSubtitle("");
      setLoginLoading(false);
    }
  };

  // Auto-submit solo all'ottava cifra (lunghezza massima): non possiamo
  // sapere quante cifre ha il PIN dell'utente finché non l'ha finito di
  // digitare, quindi per ogni lunghezza inferiore si aspetta il tocco
  // esplicito sul pulsante "Accedi".
  useEffect(() => {
    if (pin.length === 8 && !loginLoading) {
      submitRef.current(pin);
    }
  }, [pin]);

  function onDigit(d) {
    if (loginLoading) return;
    setPin(p => p.length < 8 ? p + d : p);
    setLoginErrore("");
  }
  function onDelete() {
    setPin(p => p.slice(0, -1));
    setLoginErrore("");
  }

  async function handleRegister() {
    setRegErrore("");
    const personeValide = regPersone.filter(p => p.nome.trim());
    if (!regNome.trim()) return setRegErrore(t(lang, "login.enterGroupName"));
    if (personeValide.length === 0) return setRegErrore(t(lang, "login.addAtLeastOnePerson"));
    if (regPin.length < 6) return setRegErrore(t(lang, "login.pinMin6"));
    if (regPin !== regPinConferma) return setRegErrore(t(lang, "login.pinMismatch"));
    if (regEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regEmail.trim())) return setRegErrore(t(lang, "login.invalidEmail"));
    setRegLoading(true);
    try {
      await register({ nome: regNome.trim(), persone: personeValide.map(p => ({ nome: p.nome.trim(), emoji: p.emoji })), pin: regPin, email: regEmail.trim() || undefined });
      setRegSuccesso(true);
      setTimeout(() => onLogin(), 1200);
    } catch (err) {
      setRegErrore(err.message || t(lang, "login.errorRegistration"));
    } finally { setRegLoading(false); }
  }

  function addPersona() { if (regPersone.length < 6) setRegPersone(p => [...p, { nome: "", emoji: "🙂" }]); }
  function removePersona(i) { setRegPersone(p => p.filter((_, idx) => idx !== i)); setEmojiPickerIdx(null); }
  function updatePersonaNome(i, val) { setRegPersone(p => p.map((x, idx) => idx === i ? { ...x, nome: val } : x)); }
  function updatePersonaEmoji(i, emoji) { setRegPersone(p => p.map((x, idx) => idx === i ? { ...x, emoji } : x)); setEmojiPickerIdx(null); }

  function openForgotPin() {
    setForgotStep("email"); setForgotEmail(""); setForgotCode(""); setForgotNewPin("");
    setForgotNewPinConferma(""); setForgotErrore(""); setForgotMsg("");
  }
  function closeForgotPin() { setForgotStep(null); }

  async function handleForgotRequest() {
    setForgotErrore("");
    if (!forgotEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forgotEmail.trim()))
      return setForgotErrore(t(lang, "toast.enterValidEmail"));
    setForgotLoading(true);
    try {
      const res = await requestPinReset(forgotEmail.trim());
      setForgotMsg(res.message || t(lang, "login.emailLinkedMsg"));
      setForgotStep("code");
    } catch (err) {
      setForgotErrore(err.message || t(lang, "login.requestFailed"));
    } finally { setForgotLoading(false); }
  }

  async function handleForgotConfirm() {
    setForgotErrore("");
    if (!/^\d{6}$/.test(forgotCode.trim())) return setForgotErrore(t(lang, "login.enterCode6"));
    if (!/^\d{6,8}$/.test(forgotNewPin)) return setForgotErrore(t(lang, "login.newPinLength"));
    if (forgotNewPin !== forgotNewPinConferma) return setForgotErrore(t(lang, "login.pinMismatch"));
    setForgotLoading(true);
    try {
      await confirmPinReset({ email: forgotEmail.trim(), code: forgotCode.trim(), newPin: forgotNewPin });
      closeForgotPin();
      onLogin();
    } catch (err) {
      setForgotErrore(err.message || t(lang, "login.resetFailed"));
    } finally { setForgotLoading(false); }
  }

  const sBtn = { width: "100%", padding: "16px", border: "none", borderRadius: 16, fontFamily: "'DM Sans',sans-serif", fontSize: 16, fontWeight: 700, marginTop: 16, transition: "all 0.3s", cursor: "pointer" };
  const smallInput = { ...inputStyle, padding: "12px 14px", fontSize: 14, background: "#111119" };

  return (
    <div style={{ maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "#111119", color: "#eee", fontFamily: "'DM Sans',sans-serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <style>{`
        @keyframes pinShake {
          0%,100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }
      `}</style>

      <div style={{ fontSize: 36, fontWeight: 800, marginBottom: 4 }}>
        <span style={{ background: "linear-gradient(135deg, #6C5CE7, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Finanza</span>
      </div>
      <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, marginBottom: 32 }}>{t(lang, "header.tracker")}</div>

      {/* PIN change screen */}
      {mode === "change-pin" && (
        <div style={{ width: "100%", maxWidth: 300, textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t(lang, "login.updatePin")}</div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>
            {changePinStep === "new" ? t(lang, "login.choosePinMin6") : t(lang, "login.confirmNewPin")}
          </div>
          <PinDots value={changePinStep === "new" ? newPin : newPinConferma} maxLen={8} shake={false} />
          {changePinErrore && <div style={{ color: "#FF6B6B", fontSize: 13, marginTop: 8 }}>{changePinErrore}</div>}
          <div style={{ marginTop: 16 }}>
            <NumPad onDigit={handleChangePinDigit} onDelete={handleChangePinDelete} disabled={changePinLoading} />
          </div>
          {(changePinStep === "new" ? newPin.length >= 6 : newPinConferma.length >= 6) && (
            <button onClick={handleChangePinNext} disabled={changePinLoading} style={{
              marginTop: 16, width: "100%", padding: "14px", border: "none", borderRadius: 12,
              background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff",
              fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700, cursor: "pointer",
            }}>{changePinStep === "new" ? t(lang, "login.next") : (changePinLoading ? t(lang, "conti.saving") : t(lang, "login.savePin"))}</button>
          )}
        </div>
      )}

      {/* Mode toggle — hidden during PIN change */}
      {mode !== "change-pin" && <div style={{ display: "flex", background: "#1a1a28", borderRadius: 12, padding: 4, marginBottom: 28, width: "100%", maxWidth: 300 }}>
        {[["login", t(lang, "login.login")], ["register", t(lang, "login.createAccount")]].map(([m, label]) => (
          <button key={m} onClick={() => { setMode(m); setLoginErrore(""); setRegErrore(""); setPin(""); }} style={{
            flex: 1, padding: "10px", border: "none", borderRadius: 9, cursor: "pointer",
            fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700,
            background: mode === m ? "linear-gradient(135deg, #6C5CE7, #a855f7)" : "transparent",
            color: mode === m ? "#fff" : "#666", transition: "all 0.2s",
          }}>{label}</button>
        ))}
      </div>}

      {mode !== "change-pin" && <div style={{ width: "100%", maxWidth: 300 }}>

        {mode === "login" ? (
          <>
            <div style={{ textAlign: "center", color: "#888", fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>
              {loginLoading ? t(lang, "login.loggingIn") : t(lang, "login.enterPin")}
            </div>
            {loginSubtitle && (
              <div style={{ textAlign: "center", color: "#6C5CE7", fontSize: 11, marginTop: 4, letterSpacing: 0.3 }}>
                {loginSubtitle}
              </div>
            )}

            <PinDots value={pin} maxLen={Math.max(PIN_LEN, pin.length)} shake={pinShake} />

            {loginErrore && (
              <div style={{ textAlign: "center", color: "#FF6B6B", fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
                {loginErrore}
              </div>
            )}

            <NumPad onDigit={onDigit} onDelete={onDelete} disabled={loginLoading} />

            {/* Spazio sempre riservato: mostrare/nascondere il pulsante con
                opacity invece di montarlo/smontarlo evita che il tastierino
                si sposti mentre l'utente sta ancora digitando il PIN. */}
            {(() => {
              const showAccedi = pin.length >= 4 && pin.length < 8;
              return (
                <div style={{ minHeight: 72 }}>
                  <button
                    onClick={() => submitRef.current(pin)}
                    disabled={loginLoading || !showAccedi}
                    style={{
                      ...sBtn, marginTop: 20, background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff",
                      opacity: showAccedi ? (loginLoading ? 0.6 : 1) : 0,
                      pointerEvents: showAccedi ? "auto" : "none",
                      transition: "opacity 0.2s ease",
                    }}
                  >
                    {loginLoading ? t(lang, "login.loggingInShort") : t(lang, "login.login")}
                  </button>
                </div>
              );
            })()}

            <div style={{ textAlign: "center", marginTop: 4 }}>
              <button onClick={openForgotPin} style={{ background: "none", border: "none", color: "#666", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif", textDecoration: "underline" }}>
                {t(lang, "login.forgotPin")}
              </button>
            </div>
          </>
        ) : regSuccesso ? (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#4ECDC4" }}>{t(lang, "login.accountCreated")}</div>
            <div style={{ fontSize: 13, color: "#888", marginTop: 6 }}>{t(lang, "login.loggingIn")}</div>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>{t(lang, "login.groupName")}</label>
              <input type="text" value={regNome} onChange={e => setRegNome(e.target.value)} placeholder={t(lang, "login.groupNamePlaceholder")}
                style={smallInput} autoFocus />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>{t(lang, "login.people")}</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {regPersone.map((p, i) => (
                  <div key={i}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {/* Emoji button */}
                      <button
                        onClick={() => setEmojiPickerIdx(emojiPickerIdx === i ? null : i)}
                        style={{
                          flexShrink: 0, width: 44, height: 44, border: "1px solid #252538",
                          borderRadius: 10, background: emojiPickerIdx === i ? "#252538" : "#1a1a28",
                          cursor: "pointer", fontSize: 22, display: "flex", alignItems: "center", justifyContent: "center",
                          transition: "background 0.15s",
                        }}
                      >{p.emoji}</button>
                      <input type="text" value={p.nome} onChange={e => updatePersonaNome(i, e.target.value)}
                        placeholder={`${t(lang, "login.personPrefix")} ${i + 1}`} style={{ ...smallInput, flex: 1 }} />
                      {regPersone.length > 1 && (
                        <button onClick={() => removePersona(i)} style={{ background: "none", border: "1px solid #333", borderRadius: 8, color: "#888", cursor: "pointer", padding: "8px 10px", fontSize: 14, flexShrink: 0 }}>×</button>
                      )}
                    </div>
                    {/* Emoji picker panel */}
                    {emojiPickerIdx === i && (
                      <div style={{
                        marginTop: 6, padding: "10px 8px", background: "#1a1a28", borderRadius: 12,
                        border: "1px solid #252538", display: "flex", flexWrap: "wrap", gap: 4,
                      }}>
                        {["😀","😊","😎","🥰","🤩","😄","😁","🥳","😇","🤓","😏","😌","🧐","🤗","😜",
                          "👩","👨","🧑","👧","👦","👩‍💻","👨‍💻","👩‍🍳","👨‍🍳","👩‍🎨","👨‍🎨","👩‍🎤","👨‍🎤",
                          "🐶","🐱","🐼","🦊","🐨","🐯","🦁","🐻","🐸","🐙","🦋","🌸","⭐","🔥","💎",
                          "🚀","🎸","🎮","⚽","🏀","🎾","🏄","🧗","🎯","🎲","🏆","🎪"
                        ].map(e => (
                          <button key={e} onClick={() => updatePersonaEmoji(i, e)} style={{
                            background: p.emoji === e ? "#6C5CE722" : "none",
                            border: p.emoji === e ? "1px solid #6C5CE7" : "1px solid transparent",
                            borderRadius: 8, cursor: "pointer", fontSize: 20, padding: "4px 6px",
                            transition: "all 0.1s",
                          }}>{e}</button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {regPersone.length < 6 && (
                  <button onClick={addPersona} style={{ background: "none", border: "1px dashed #333", borderRadius: 10, color: "#666", cursor: "pointer", padding: "10px", fontSize: 13, fontFamily: "'DM Sans',sans-serif" }}>{t(lang, "login.addPerson")}</button>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>{t(lang, "login.pinLabel")}</label>
              <input type="password" inputMode="numeric" maxLength={8} value={regPin}
                onChange={e => setRegPin(e.target.value.replace(/\D/g, ""))}
                placeholder="••••" style={{ ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center" }} />
            </div>

            <div style={{ marginBottom: 6 }}>
              <label style={labelStyle}>{t(lang, "login.confirmPinLabel")}</label>
              <input type="password" inputMode="numeric" maxLength={8} value={regPinConferma}
                onChange={e => setRegPinConferma(e.target.value.replace(/\D/g, ""))}
                onKeyDown={e => e.key === "Enter" && handleRegister()}
                placeholder="••••" style={{
                  ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center",
                  borderColor: regPinConferma && regPin !== regPinConferma ? "#FF6B6B" : "#252538",
                }} />
            </div>

            <div style={{ marginBottom: 6 }}>
              <label style={labelStyle}>{t(lang, "login.recoveryEmailLabel")}</label>
              <input type="email" inputMode="email" value={regEmail}
                onChange={e => setRegEmail(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleRegister()}
                placeholder="tuaemail@esempio.com" style={smallInput} />
              <div style={{ fontSize: 11, color: "#666", marginTop: 6 }}>{t(lang, "login.recoveryEmailHint")}</div>
            </div>

            {regErrore && <div style={{ marginTop: 10, textAlign: "center", color: "#FF6B6B", fontSize: 13, fontWeight: 600 }}>{regErrore}</div>}

            <button onClick={handleRegister} disabled={regLoading} style={{
              ...sBtn, background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff", opacity: regLoading ? 0.6 : 1,
            }}>{regLoading ? t(lang, "login.creating") : t(lang, "login.createAccount")}</button>
          </>
        )}
      </div>}

      {forgotStep && (
        <div style={{
          position: "fixed", inset: 0, background: "#000000cc", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div style={{ background: "#1a1a28", borderRadius: 20, padding: 24, width: "100%", maxWidth: 340, border: "1px solid #252538" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#eee" }}>{t(lang, "login.forgotPinTitle")}</div>
              <button onClick={closeForgotPin} style={{ background: "none", border: "none", color: "#666", fontSize: 18, cursor: "pointer" }}>✕</button>
            </div>

            {forgotStep === "email" ? (
              <>
                <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
                  {t(lang, "login.forgotPinEmailHint")}
                </div>
                <input type="email" inputMode="email" autoFocus value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleForgotRequest()}
                  placeholder="tuaemail@esempio.com" style={{ ...smallInput, marginBottom: 12 }} />
                {forgotErrore && <div style={{ color: "#FF6B6B", fontSize: 13, fontWeight: 600, marginBottom: 10, textAlign: "center" }}>{forgotErrore}</div>}
                <button onClick={handleForgotRequest} disabled={forgotLoading} style={{
                  ...sBtn, marginTop: 4, background: "linear-gradient(135deg, #6C5CE7, #a855f7)", color: "#fff", opacity: forgotLoading ? 0.6 : 1,
                }}>{forgotLoading ? t(lang, "login.sendingCode") : t(lang, "login.sendCode")}</button>
              </>
            ) : (
              <>
                {forgotMsg && <div style={{ fontSize: 12, color: "#4ECDC4", marginBottom: 14, textAlign: "center" }}>{forgotMsg}</div>}

                <label style={labelStyle}>{t(lang, "login.codeReceivedLabel")}</label>
                <input type="text" inputMode="numeric" maxLength={6} value={forgotCode}
                  onChange={e => setForgotCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456" style={{ ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 6, textAlign: "center", marginBottom: 12 }} />

                <label style={labelStyle}>{t(lang, "login.newPinLabel")}</label>
                <input type="password" inputMode="numeric" maxLength={8} value={forgotNewPin}
                  onChange={e => setForgotNewPin(e.target.value.replace(/\D/g, ""))}
                  placeholder="••••••" style={{ ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center", marginBottom: 12 }} />

                <label style={labelStyle}>{t(lang, "login.confirmNewPinLabel")}</label>
                <input type="password" inputMode="numeric" maxLength={8} value={forgotNewPinConferma}
                  onChange={e => setForgotNewPinConferma(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={e => e.key === "Enter" && handleForgotConfirm()}
                  placeholder="••••••" style={{
                    ...smallInput, fontFamily: "'Space Mono',monospace", letterSpacing: 8, textAlign: "center", marginBottom: 6,
                    borderColor: forgotNewPinConferma && forgotNewPin !== forgotNewPinConferma ? "#FF6B6B" : "#252538",
                  }} />

                {forgotErrore && <div style={{ color: "#FF6B6B", fontSize: 13, fontWeight: 600, marginTop: 6, textAlign: "center" }}>{forgotErrore}</div>}

                <button onClick={handleForgotConfirm} disabled={forgotLoading} style={{
                  ...sBtn, background: "linear-gradient(135deg, #4ECDC4, #3ab8b0)", color: "#0a0a12", opacity: forgotLoading ? 0.6 : 1,
                }}>{forgotLoading ? t(lang, "login.resettingPin") : t(lang, "login.resetPinAndLogin")}</button>

                <button onClick={() => setForgotStep("email")} style={{ width: "100%", background: "none", border: "none", color: "#666", fontSize: 12, cursor: "pointer", marginTop: 10, textDecoration: "underline" }}>
                  {t(lang, "login.noCodeRetry")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
