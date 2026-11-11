"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";

export default function NotFound() {
  const router = useRouter();

  const returnToPreviousPage = () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    router.push("/");
  };

  return (
    <main className="clear-404">
      <header className="clear-404-header">
        <Link className="clear-404-brand" href="/" aria-label="ClearAid home">
          <Image src="/clearaid-mark.svg" alt="" width={42} height={42} unoptimized />
          <span>ClearAid</span>
        </Link>
      </header>

      <section className="clear-404-content" aria-labelledby="clear-404-title">
        <div className="clear-404-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none">
            <path d="M19 17.5h-3a8 8 0 0 0 0 16h7" />
            <path d="M29 30.5h3a8 8 0 0 0 0-16h-7" />
            <path d="m20 29 8-10M20 19l8 10" />
          </svg>
        </div>
        <p className="clear-404-code">404</p>
        <h1 id="clear-404-title">Nothing at this address.</h1>
        <p className="clear-404-copy">Let’s get you back to the ClearAid workspace.</p>
        <div className="clear-404-actions">
          <Link className="clear-404-home" href="/">Go to ClearAid home</Link>
          <button className="clear-404-back" type="button" onClick={returnToPreviousPage}>
            Or return to your previous page
          </button>
        </div>
      </section>
    </main>
  );
}
