/**
 * Devin `GetUserStatus` plan status as quota windows (`daily`, `weekly`).
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/features/quota/providers/devin/data.ts and
 * requests.ts (`dailyQuotaRemainingPercent`, `weeklyQuotaRemainingPercent`, `*QuotaResetAtUnix`, periods 24 h and
 * 168 h). The request itself is the existing server-side call (`fetchDevinUserStatus` in
 * src/credentials/devin-status.ts, the binary Connect-RPC form the `devin-user-status` cron uses), not the panel's JSON
 * form; the panel shows remaining percentages, the report stores `used = 100 - remaining`.
 */
import type { QuotaWindow } from "../management/contract/credentials.ts";
import type { DevinUserStatus } from "../oauth/flows/devin-status.ts";
import { DAY, WEEK, quotaWindow, unixIso } from "./window.ts";

export interface DevinUsage {
  readonly plan?: string;
  readonly windows: QuotaWindow[];
}

/** Windows and plan of a parsed `GetUserStatus` answer. */
export const devinUsage = (status: DevinUserStatus): DevinUsage => {
  const plan = status.plan.trim();

  return {
    ...(plan === "" ? {} : { plan }),
    windows: [
      quotaWindow(
        "daily",
        "Daily",
        100 - status.dailyQuotaRemainingPercent,
        unixIso(status.dailyQuotaResetAt),
        DAY,
      ),
      quotaWindow(
        "weekly",
        "Weekly",
        100 - status.weeklyQuotaRemainingPercent,
        unixIso(status.weeklyQuotaResetAt),
        WEEK,
      ),
    ],
  };
};
