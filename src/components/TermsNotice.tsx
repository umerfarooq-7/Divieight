import { TERMS_EFFECTIVE, TERMS_VERSION } from "@/lib/terms";

/** The Terms link on the registration screens. It opens in a new tab so a half-filled form is not lost. */
export function TermsNotice() {
  return (
    <p className="text-center text-sm text-muted-foreground">
      By creating an account you agree to the{" "}
      <a href="/terms" target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-2">
        Terms and Conditions
      </a>{" "}
      (version {TERMS_VERSION}, effective {TERMS_EFFECTIVE}). You can read them without signing in.
    </p>
  );
}
