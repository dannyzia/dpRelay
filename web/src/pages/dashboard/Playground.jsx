import React, { useEffect, useState } from "react";
import { listApps, sendOtpHttps, verifyOtpHttps } from "../../utils/firebase";
import Button from "../../components/ui/Button";

export default function Playground() {
  const [apps, setApps] = useState([]);
  const [selectedAppId, setSelectedAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [tab, setTab] = useState("send");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [otp, setOtp] = useState("");
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  /** Countdown seconds remaining after a successful OTP send (0 = ready). */
  const [cooldown, setCooldown] = useState(0);

  /**
   * Synchronous guard to prevent concurrent OTP sends.
   * React state updates (setSending) are batched and async — a rapid double-click
   * can fire the handler twice before the re-render disables the button.
   * This ref is checked and set synchronously, closing the race window.
   */
  const sendingRef = React.useRef(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await listApps();
        const appList = res.data.apps || [];
        setApps(appList);
        if (appList.length === 1) {
          setSelectedAppId(appList[0].appId);
        }
      } catch {
        // Silent fail — playground works without app data
      }
    };
    load();
  }, []);

  // Decrement the cooldown counter every second until it reaches zero.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleSendOtp = async () => {
    if (!selectedAppId || !appSecret || !phoneNumber) return;
    // Synchronous guard — prevents duplicate sends from rapid clicks before React re-renders.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    setResponse(null);
    try {
      const data = await sendOtpHttps({
        appId: selectedAppId,
        appSecret,
        phoneNumber,
      });
      setResponse(data);
      if (data.sessionId) {
        setSessionId(data.sessionId);
        // Start 30-second client-side cooldown that mirrors the server-side lock.
        setCooldown(30);
      }
    } catch (err) {
      setError(err.message || "Failed to send OTP");
      setResponse({ error: err.message });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (!selectedAppId || !sessionId || !otp) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    setResponse(null);
    try {
      const data = await verifyOtpHttps({
        appId: selectedAppId,
        sessionId,
        otp,
      });
      setResponse(data);
    } catch (err) {
      setError(err.message || "Failed to verify OTP");
      setResponse({ error: err.message });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">API Playground</h1>
        <p className="mt-1 text-sm text-gray-500">
          Test your OTP integration live before writing code.
        </p>
        <div className="mt-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          Your appSecret is never stored by this page; it is only used to sign
          requests in your browser.
        </div>
      </div>

      {/* App selection */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="playground-app"
            className="block text-sm font-medium text-gray-700"
          >
            App
          </label>
          <select
            id="playground-app"
            value={selectedAppId}
            onChange={(e) => setSelectedAppId(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm"
          >
            <option value="">Select an app</option>
            {apps.map((app) => (
              <option key={app.appId} value={app.appId}>
                {app.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="playground-secret"
            className="block text-sm font-medium text-gray-700"
          >
            App Secret
          </label>
          <input
            id="playground-secret"
            name="appSecret"
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            placeholder="Enter your app secret"
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-2 border-b border-gray-200">
        <button
          onClick={() => setTab("send")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "send" ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
        >
          Send OTP
        </button>
        <button
          onClick={() => setTab("verify")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "verify" ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
        >
          Verify OTP
        </button>
      </div>

      {/* Send OTP tab */}
      {tab === "send" && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <label
            htmlFor="phone"
            className="block text-sm font-medium text-gray-700"
          >
            Phone Number (E.164)
          </label>
          <input
            id="phone"
            name="phoneNumber"
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+8801712345678"
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
          <p className="mt-1 text-xs text-gray-400">
            Include country code, e.g.{" "}
            <span className="font-mono">+8801712345678</span>
          </p>
          <Button
            variant="primary"
            className="mt-4"
            onClick={handleSendOtp}
            disabled={
              sending ||
              cooldown > 0 ||
              !selectedAppId ||
              !appSecret ||
              !phoneNumber
            }
          >
            {sending
              ? "Sending…"
              : cooldown > 0
                ? `Wait ${cooldown}s`
                : "Send OTP"}
          </Button>
        </div>
      )}

      {/* Verify OTP tab */}
      {tab === "verify" && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="verify-session"
                className="block text-sm font-medium text-gray-700"
              >
                Session ID
              </label>
              <input
                id="verify-session"
                name="sessionId"
                type="text"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                placeholder="Session ID from send response"
              />
            </div>
            <div>
              <label
                htmlFor="verify-otp"
                className="block text-sm font-medium text-gray-700"
              >
                OTP Code
              </label>
              <input
                id="verify-otp"
                name="otpCode"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                placeholder="6-digit OTP"
              />
            </div>
          </div>
          <Button
            variant="primary"
            className="mt-4"
            onClick={handleVerifyOtp}
            disabled={sending || !selectedAppId || !sessionId || !otp}
          >
            {sending ? "Verifying…" : "Verify OTP"}
          </Button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Response */}
      {response && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Response</h3>
          <pre className="rounded-lg border border-gray-200 bg-gray-900 p-4 text-sm text-green-400 overflow-x-auto">
            {JSON.stringify(response, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
