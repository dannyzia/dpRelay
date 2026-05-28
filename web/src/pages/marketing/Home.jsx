import React from "react";
import { Link } from "react-router-dom";
import Badge from "../../components/ui/Badge";

const comparisonRows = [
  {
    feature: "Infrastructure",
    traditional: "Shared, generic numbers",
    dprelay: "Dedicated, physical Android device",
  },
  {
    feature: "Delivery Speed",
    traditional: "10-30 seconds (queued)",
    dprelay: "~2-5 seconds (direct from SIM)",
  },
  {
    feature: "Sender ID",
    traditional: "Often changes, random numbers",
    dprelay: "Consistent (your device's number)",
  },
  {
    feature: "Reliability",
    traditional: "Prone to carrier blocking and spam filters",
    dprelay: "High reliability, trusted hardware anchor",
  },
];

const keyFeatures = [
  {
    title: "Hardware-Authenticated Delivery",
    description:
      "Every SMS originates from a dedicated Android device that you control. This means no reliance on third-party gateways, no shared sender IDs, and no unpredictable carrier filtering. Your OTPs arrive from the same number every time, building trust with your users.",
    icon: "📱",
  },
  {
    title: "Separate Credit Pools",
    description:
      "Never mix your transactional and marketing messages again. dpRelay provides independent credit pools for OTPs (high reliability, low volume) and bulk SMS (high volume, cost-optimized). You buy exactly what you need, ensuring critical OTPs are never delayed by bulk campaigns.",
    icon: "💳",
  },
  {
    title: "Developer Experience First",
    description:
      "Integrate in minutes with our clear REST API, ready-to-copy code examples for popular frameworks (Node.js, Laravel, Next.js, etc.), and a built-in API Playground. We also offer webhooks for real-time delivery status, so your app instantly knows when an OTP is delivered, fails, or expires.",
    icon: "🛠️",
  },
  {
    title: "Built for Bangladesh",
    description:
      "We fully support +880 numbers and offer local payment methods like bKash. Our affordable pricing means you pay for credits, not per-request international fees. Plus, our local support team understands carrier behaviour and SMS character sets.",
    icon: "🇧🇩",
  },
];

const audienceCards = [
  {
    heading: "For Developers",
    description:
      "Stop wrestling with unreliable SMS gateways. dpRelay gives you a clean API, webhooks, and a hardware-backed delivery system that actually works. Get OTPs in seconds, not minutes, and focus on building your app.",
    icon: "💻",
  },
  {
    heading: "For Business Owners",
    description:
      "Build trust with your customers. Every verification SMS comes from your own dedicated number, eliminating random sender IDs. Plus, you can run targeted bulk campaigns from the same easy-to-use dashboard.",
    icon: "🏢",
  },
  {
    heading: "For Agencies and Resellers",
    description:
      "Want to white-label an OTP service for your clients? We support per-app API keys and separate billing, allowing you to manage multiple clients securely and efficiently. Contact us for partnership opportunities.",
    icon: "🤝",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-white">
      {/* ── Hero Section ── */}
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-50 via-white to-green-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 md:py-32">
          <div className="text-center">
            <div className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-brand-100 text-brand-700 mb-6">
              Developer-first OTP &amp; bulk SMS platform for Bangladesh
            </div>
            <h1 className="text-4xl md:text-6xl font-extrabold text-gray-900 tracking-tight mb-6">
              Stop Wrestling with Unreliable
              <br className="hidden md:block" /> SMS Gateways.{" "}
              <span className="text-brand-600">Get OTPs in Seconds.</span>
            </h1>
            <p className="text-lg md:text-xl text-gray-600 max-w-3xl mx-auto mb-10 leading-relaxed">
              dpRelay is a developer-first OTP and bulk SMS platform built for
              Bangladesh. Experience unmatched delivery reliability, consistent
              sender IDs, and a simple API powered by our unique
              hardware-authenticated system.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                to="/register"
                className="px-8 py-3 rounded-lg bg-brand-600 text-white text-lg font-semibold hover:bg-brand-700 transition-colors shadow-lg shadow-brand-200"
              >
                Start Free Trial
              </Link>
              <Link
                to="/api-docs"
                className="px-8 py-3 rounded-lg border border-gray-300 text-gray-700 text-lg font-semibold hover:bg-gray-50 transition-colors"
              >
                View API Docs
              </Link>
            </div>
          </div>

          <div className="mt-16 flex justify-center">
            <div className="bg-white rounded-2xl shadow-xl p-4 max-w-md w-full border border-gray-100">
              <div className="flex items-center space-x-3 mb-4 p-3 bg-gray-50 rounded-lg">
                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-400 text-sm">
                  📱
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    +880 17XX-XXXXXX
                  </p>
                  <p className="text-xs text-gray-400">OTP: 482913</p>
                </div>
                <div className="ml-auto">
                  <Badge variant="success">Delivered</Badge>
                </div>
              </div>
              <p className="text-xs text-gray-400 text-center">
                Example OTP delivery — actual numbers vary
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Problem vs. Solution Comparison ── */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Why Traditional Gateways Fail{" "}
              <span className="text-brand-600">(And How We Fix It)</span>
            </h2>
            <p className="text-lg text-gray-600 max-w-2xl mx-auto">
              Most OTP and bulk SMS services rely on shared aggregator gateways,
              leading to low delivery rates, slow speeds, and random sender IDs.
              dpRelay changes the game with a radically different approach.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full max-w-4xl mx-auto text-sm text-left border border-gray-200 rounded-xl overflow-hidden">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="py-4 px-6 font-semibold text-gray-900">
                    Feature
                  </th>
                  <th className="py-4 px-6 font-semibold text-gray-500">
                    Traditional Gateways
                  </th>
                  <th className="py-4 px-6 font-semibold text-brand-700">
                    dpRelay
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row, idx) => (
                  <tr
                    key={idx}
                    className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/60"}
                  >
                    <td className="py-4 px-6 font-medium text-gray-900">
                      {row.feature}
                    </td>
                    <td className="py-4 px-6 text-gray-500">
                      {row.traditional}
                    </td>
                    <td className="py-4 px-6 text-brand-700 font-medium">
                      {row.dprelay}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Key Features and Benefits ── */}
      <section className="py-20 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Built for Reliability,{" "}
              <span className="text-brand-600">Designed for Developers</span>
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {keyFeatures.map((feature, idx) => (
              <div
                key={idx}
                className="bg-white border border-gray-100 rounded-xl p-8 hover:shadow-md transition-shadow"
              >
                <div className="text-4xl mb-4">{feature.icon}</div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  {feature.title}
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Target Audience Messaging ── */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Who is <span className="text-brand-600">dpRelay</span> For?
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {audienceCards.map((card, idx) => (
              <div
                key={idx}
                className="bg-white border border-gray-100 rounded-xl p-8 hover:shadow-md transition-shadow text-center"
              >
                <div className="text-4xl mb-4">{card.icon}</div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  {card.heading}
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed">
                  {card.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final Call to Action ── */}
      <section className="py-20 bg-brand-700">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold text-white mb-6">
            Ready to Experience Reliable SMS Delivery?
          </h2>
          <p className="text-lg text-brand-200 mb-10 max-w-2xl mx-auto">
            Join the developers and businesses across Bangladesh who trust
            dpRelay. Start verifying users in minutes.
          </p>
          <Link
            to="/register"
            className="px-8 py-3 rounded-lg bg-white text-brand-700 text-lg font-semibold hover:bg-brand-50 transition-colors shadow-lg shadow-black/20 inline-block"
          >
            Get Started with 50 Free OTPs
          </Link>
        </div>
      </section>
    </div>
  );
}
