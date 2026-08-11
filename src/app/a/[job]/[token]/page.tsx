import { boot } from "@/lib/server/http";
import { readApproval } from "@/lib/server/engine";
import ApprovalCard from "./ApprovalCard";

export const dynamic = "force-dynamic";

/**
 * The approval page (spec §6).
 *
 * A human opens this link from wherever the tool answer landed — a chat client, a
 * terminal, an email — so it renders on its own, without the console's chrome and without
 * needing a session. What it shows is what the spec asks for: the model, the parameters,
 * the price and the balance, then two buttons.
 */
export default async function ApprovalPage({ params }: { params: Promise<{ job: string; token: string }> }) {
  boot();
  const { job, token } = await params;
  const approval = readApproval(job, token);

  if (!approval) {
    return (
      <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 24 }}>
        <div className="panel" style={{ maxWidth: 520 }}>
          <div className="panel-head">
            <span className="dot red" />
            <span className="panel-title">Approval</span>
          </div>
          <div className="panel-body">
            <div className="error-box">This approval link is unknown, already spent, or was never valid.</div>
            <div className="hint">Links are one-time and expire 15 minutes after the job was blocked.</div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 24 }}>
      <ApprovalCard approval={approval} jobId={job} token={token} />
    </main>
  );
}
