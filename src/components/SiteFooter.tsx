import { Link } from "@tanstack/react-router";
import { STANDARD_ON_REQUEST } from "@/lib/standard-version";
import { Facebook, Instagram, Linkedin, Twitter } from "lucide-react";

const social = [
  { icon: Twitter, label: "Twitter" },
  { icon: Linkedin, label: "LinkedIn" },
  { icon: Instagram, label: "Instagram" },
  { icon: Facebook, label: "Facebook" },
];

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-secondary/40">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-4 lg:px-8">
        <div className="md:col-span-1">
          <p className="font-display text-lg font-semibold text-foreground">divieight</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Independent co-ownership. Buy or sell a second home in eight equal shares.
          </p>
          <div className="mt-4 flex items-center gap-2">
            {social.map(({ icon: Icon, label }) => (
              <span
                key={label}
                aria-label={label}
                title={label}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
              >
                <Icon className="h-4 w-4" />
              </span>
            ))}
          </div>
        </div>

        <FooterCol title="Company">
          <FooterLink to="/">Home</FooterLink>
          <FooterLink to="/about">About</FooterLink>
          <FooterLink to="/contact">Contact</FooterLink>
          <FooterLink to="/support">Support</FooterLink>
        </FooterCol>

        <FooterCol title="Buyers">
          <FooterLink to="/properties">Browse properties</FooterLink>
          <FooterLink to="/buyer/register">Become a buyer</FooterLink>
          <FooterLink to="/buyer/login">Buyer sign in</FooterLink>
        </FooterCol>

        <FooterCol title="Sellers">
          <FooterLink to="/listings/new">List your property</FooterLink>
          <FooterLink to="/dashboard">Seller dashboard</FooterLink>
          <FooterLink to="/login">Seller sign in</FooterLink>
          <FooterLink to="/register">Create seller account</FooterLink>
        </FooterCol>

      </div>

      <div className="border-t border-border/60 py-5">
        {/* "Standard on request" is only this text: no form, no link to one. */}
        <p className="mx-auto max-w-7xl px-4 pb-2 text-center text-xs text-muted-foreground sm:px-6 lg:px-8">
          {STANDARD_ON_REQUEST.label}: {STANDARD_ON_REQUEST.text}
        </p>
        <p className="mx-auto max-w-7xl px-4 pb-2 text-center text-sm sm:px-6 lg:px-8">
          <Link to="/terms" className="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
            Terms and Conditions
          </Link>
        </p>
        <p className="mx-auto max-w-7xl px-4 text-center text-xs text-muted-foreground sm:px-6 lg:px-8">
          © {new Date().getFullYear()} divieight — Fractional real estate co-ownership. All rights
          reserved.
        </p>
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-foreground">{title}</p>
      <ul className="mt-3 space-y-2">{children}</ul>
    </div>
  );
}

function FooterLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <li>
      <Link
        to={to}
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {children}
      </Link>
    </li>
  );
}
