import React, { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { collection, getDocs, query, where, orderBy } from "firebase/firestore";
import { db } from "../../utils/firebase";

/**
 * Normalises a Firestore package document to a consistent shape.
 * Handles legacy field names (credits → sms_quota, price → price_bdt).
 */
const normalisePackage = (pkg) => ({
  ...pkg,
  sms_quota: pkg.sms_quota ?? pkg.credits ?? 0,
  price_bdt: pkg.price_bdt ?? pkg.price ?? 0,
  name: pkg.name || "Unnamed Package",
  type: (pkg.type || "otp").toLowerCase(),
});

/**
 * Formats an OTP count with comma separators.
 */
const formatQuota = (n) => n.toLocaleString("en-US");

const faqs = [
  {
    q: "How long does it take to deliver an OTP?",
    a: "Most OTPs are delivered within 5-15 seconds via our local SMS gateways in Bangladesh. Delivery time may vary based on network conditions.",
  },
  {
    q: "Can I use this service for international numbers?",
    a: "Currently we specialize in Bangladeshi phone numbers (+880). International number support is coming soon. Contact us for specific requirements.",
  },
  {
    q: "What happens if an SMS fails to deliver?",
    a: "We automatically retry delivery up to 3 times. If all attempts fail, you will receive a delivery failure webhook callback. Failed OTPs are not deducted from your balance.",
  },
  {
    q: "Can I get a refund for unused credits?",
    a: "Unused credits from the Trial package expire after 7 days. For paid packages, unused credits are valid until the package expiry date. We do not offer cash refunds for unused credits.",
  },
  {
    q: "How do I integrate the API into my app?",
    a: "We provide complete API documentation with code examples for Laravel, React, Next.js, and more. Check our Docs page for integration guides.",
  },
  {
    q: "Is there a rate limit?",
    a: "Standard rate limit is 1 OTP per phone number per 60 seconds. Enterprise plans offer custom rate limits. Attempting to bypass rate limits may result in account suspension.",
  },
];

export default function Pricing() {
  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const fetchPackages = async () => {
      try {
        const snapshot = await getDocs(
          query(
            collection(db, "packages"),
            where("is_active", "==", true),
            where("type", "in", ["otp", "both"]),
          ),
        );

        if (cancelled) return;

        const active = snapshot.docs
          .map((doc) => normalisePackage({ id: doc.id, ...doc.data() }))
          .sort((a, b) => (a.price_bdt ?? 0) - (b.price_bdt ?? 0));

        setPackages(active);
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Failed to load packages.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchPackages();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Derive a human-readable features list from the package fields,
   * so the card always shows something useful even if the admin
   * adds new packages without a dedicated features array.
   */
  const enrichedPackages = useMemo(
    () =>
      packages.map((pkg) => {
        const quotaStr = `${formatQuota(pkg.sms_quota)} OTP credit${pkg.sms_quota !== 1 ? "s" : ""}`;
        const validityStr = `${pkg.validity_days} day${pkg.validity_days !== 1 ? "s" : ""} validity`;
        const isFree = pkg.price_bdt === 0;

        const features = [];
        features.push(quotaStr);
        if (isFree) {
          features.push("Basic API access");
          features.push("Email support");
        } else if (pkg.price_bdt < 1000) {
          features.push("Priority API access");
          features.push("Webhook support");
          features.push("Email & WhatsApp support");
        } else if (pkg.price_bdt < 3000) {
          features.push("Highest priority delivery");
          features.push("Webhook support");
          features.push("Dedicated support");
          features.push("Custom integration help");
        } else {
          features.push("SLA guarantee");
          features.push("Custom webhook endpoints");
          features.push("Account manager");
          features.push("Priority queue");
        }

        return {
          ...pkg,
          smsQuota: quotaStr,
          validity: validityStr,
          priceDisplay: isFree ? "Free" : formatQuota(pkg.price_bdt),
          priceLabel: isFree ? "Free" : `BDT ${formatQuota(pkg.price_bdt)}`,
          isFree,
          features,
        };
      }),
    [packages],
  );

  /**
   * Mark the second package (after sorting by price) as "popular"
   * since the cheapest is usually a trial tier.
   */
  const popularIndex = useMemo(() => {
    if (enrichedPackages.length <= 1) return -1;
    const firstPaid = enrichedPackages.findIndex((p) => !p.isFree);
    return firstPaid >= 0 ? firstPaid : 1;
  }, [enrichedPackages]);

  return (
    <div className="min-h-screen bg-white">
      <section className="bg-gradient-to-br from-brand-50 to-white py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl font-extrabold text-gray-900 mb-4">
            Simple, Transparent Pricing
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto mb-6">
            Pay only for verified OTPs. No hidden fees, no setup costs. Choose
            the plan that fits your needs.
          </p>
          <div className="inline-flex items-center bg-white rounded-full px-4 py-1 shadow-sm border border-gray-200">
            <span className="text-sm font-medium text-gray-700">
              {enrichedPackages.length > 1
                ? `Starting at just ${(enrichedPackages.find((p) => !p.isFree)?.price_bdt / enrichedPackages.find((p) => !p.isFree)?.sms_quota).toFixed(2)} BDT per OTP`
                : "Starting at just 1 BDT per OTP"}
            </span>
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Loading state */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-16">
              <svg
                className="animate-spin h-8 w-8 text-brand-600 mb-4"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <p className="text-gray-500 text-sm">Loading packages…</p>
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="max-w-md mx-auto text-center py-16">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
                <svg
                  className="h-6 w-6 text-red-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Could not load packages
              </h3>
              <p className="text-sm text-gray-600 mb-4">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && enrichedPackages.length === 0 && (
            <div className="text-center py-16">
              <p className="text-gray-500">
                No packages available at the moment. Please check back later.
              </p>
            </div>
          )}

          {/* Package cards */}
          {!loading && !error && enrichedPackages.length > 0 && (
            <div
              className={`grid gap-8 ${
                enrichedPackages.length === 1
                  ? "grid-cols-1 max-w-sm mx-auto"
                  : enrichedPackages.length === 2
                    ? "grid-cols-1 md:grid-cols-2 max-w-2xl mx-auto"
                    : enrichedPackages.length === 3
                      ? "grid-cols-1 md:grid-cols-3 max-w-5xl mx-auto"
                      : "grid-cols-1 md:grid-cols-2 xl:grid-cols-4"
              }`}
            >
              {enrichedPackages.map((pkg, idx) => (
                <div
                  key={pkg.id}
                  className={`relative rounded-2xl border-2 p-8 flex flex-col ${
                    idx === popularIndex
                      ? "border-brand-600 bg-brand-50/50 shadow-lg shadow-brand-200/20"
                      : "border-gray-200 hover:shadow-md bg-white"
                  }`}
                >
                  {idx === popularIndex && (
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                      <span className="bg-brand-600 text-white text-xs font-semibold px-4 py-1.5 rounded-full">
                        Most Popular
                      </span>
                    </div>
                  )}
                  <h3 className="text-xl font-bold text-gray-900 mb-2">
                    {pkg.name}
                  </h3>
                  <div className="mb-4">
                    <span className="text-4xl font-extrabold text-gray-900">
                      {pkg.priceDisplay}
                    </span>
                    <span className="text-gray-500 text-lg">
                      {pkg.isFree ? "" : " BDT"}
                    </span>
                  </div>
                  <div className="space-y-2 mb-6 flex-1">
                    <p className="text-sm text-gray-500">
                      {pkg.smsQuota} &bull; {pkg.validity}
                    </p>
                    <ul className="space-y-2 mt-4">
                      {pkg.features.map((feature, fIdx) => (
                        <li
                          key={fIdx}
                          className="flex items-center text-sm text-gray-600"
                        >
                          <svg
                            className="h-4 w-4 text-brand-500 mr-2 shrink-0"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Link
                    to={pkg.isFree ? "/register" : "/dashboard/buy-credits"}
                    className={`block text-center py-3 rounded-lg font-semibold transition-colors ${
                      idx === popularIndex
                        ? "bg-brand-600 text-white hover:bg-brand-700"
                        : "bg-white text-brand-700 border border-brand-300 hover:bg-brand-50"
                    }`}
                  >
                    {pkg.isFree ? "Get Started Free" : "Buy Credits"}
                  </Link>
                </div>
              ))}
            </div>
          )}

          {/* Comparison table — keep static as it compares against competitors */}
          {!loading && !error && enrichedPackages.length > 0 && (
            <div className="mt-16 bg-gray-50 rounded-xl p-8 border border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Why Our Pricing is Better
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="py-3 px-4 text-gray-500 font-medium">
                        Provider
                      </th>
                      <th className="py-3 px-4 text-gray-500 font-medium">
                        Per SMS Rate
                      </th>
                      <th className="py-3 px-4 text-gray-500 font-medium">
                        Validity
                      </th>
                      <th className="py-3 px-4 text-gray-500 font-medium">
                        Extras
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-100">
                      <td className="py-3 px-4 font-medium">MIMS SMS</td>
                      <td className="py-3 px-4 text-gray-600">0.30-0.35 BDT</td>
                      <td className="py-3 px-4 text-gray-600">N/A</td>
                      <td className="py-3 px-4 text-gray-600">SMS only</td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-3 px-4 font-medium">Khude Barta</td>
                      <td className="py-3 px-4 text-gray-600">0.56 BDT</td>
                      <td className="py-3 px-4 text-gray-600">N/A</td>
                      <td className="py-3 px-4 text-gray-600">SMS only</td>
                    </tr>
                    <tr className="bg-brand-50">
                      <td className="py-3 px-4 font-medium text-brand-700">
                        <span className="text-brand-600">dpRelay</span>
                      </td>
                      <td className="py-3 px-4 text-brand-700 font-semibold">
                        From 0.90 BDT*
                      </td>
                      <td className="py-3 px-4 text-brand-700">
                        Up to 180 days
                      </td>
                      <td className="py-3 px-4 text-brand-700">
                        API + Webhooks + Support
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                * Effective rate based on Pro package (1,800 BDT / 2,000 OTPs).
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="py-20 bg-gray-50">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-gray-900 mb-12 text-center">
            Frequently Asked Questions
          </h2>
          <div className="space-y-6">
            {faqs.map((faq, idx) => (
              <div
                key={idx}
                className="bg-white rounded-xl border border-gray-200 p-6"
              >
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  {faq.q}
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-brand-700">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold text-white mb-6">
            Start Verifying Users Today
          </h2>
          <p className="text-lg text-brand-200 mb-10 max-w-2xl mx-auto">
            50 free OTPs to get you started. No credit card required.
          </p>
          <Link
            to="/register"
            className="px-8 py-3 rounded-lg bg-white text-brand-700 text-lg font-semibold hover:bg-brand-50 transition-colors shadow-lg shadow-black/20 inline-block"
          >
            Get Your Free OTPs
          </Link>
        </div>
      </section>
    </div>
  );
}
