import React from "react";
import { Link } from "react-router-dom";
import dpRelayLogo from "../../assets/dpRelay-logo.png";

const Footer = () => {
  return (
    <footer className="bg-gray-900 text-gray-400">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          <div>
            <div className="mb-4">
              <img
                src={dpRelayLogo}
                alt="dpRelay logo"
                className="h-8 w-auto object-contain rounded-lg"
              />
            </div>
            <p className="text-sm leading-relaxed">
              Reliable OTP verification and bulk SMS for apps in Bangladesh and
              beyond. Simple API, instant delivery, developer-friendly.
            </p>
          </div>
          <div>
            <h4 className="text-white font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link
                  to="/pricing"
                  className="hover:text-white transition-colors"
                >
                  Pricing
                </Link>
              </li>
              <li>
                <Link
                  to="/api-docs"
                  className="hover:text-white transition-colors"
                >
                  Documentation
                </Link>
              </li>
              <li>
                <Link
                  to="/contact"
                  className="hover:text-white transition-colors"
                >
                  Contact
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="text-white font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <span className="hover:text-white transition-colors cursor-pointer">
                  About
                </span>
              </li>
              <li>
                <span className="hover:text-white transition-colors cursor-pointer">
                  Privacy Policy
                </span>
              </li>
              <li>
                <span className="hover:text-white transition-colors cursor-pointer">
                  Terms of Service
                </span>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="text-white font-semibold mb-4">Support</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href="mailto:support@dprelay.com"
                  className="hover:text-white transition-colors"
                >
                  support@dprelay.com
                </a>
              </li>
              <li>
                <a
                  href="tel:+8801700000000"
                  className="hover:text-white transition-colors"
                >
                  +880 1700-000000
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-gray-800 pt-8 text-center text-sm">
          <p>
            &copy; {new Date().getFullYear()}{" "}
            <span className="text-brand-400">dpRelay</span>. All rights
            reserved. Built for Bangladesh.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
