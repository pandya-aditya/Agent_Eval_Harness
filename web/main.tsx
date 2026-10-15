import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Invoice = {
  id: number;
  invoice_number: string;
  status: string;
  customer_id: number | null;
  customer_name: string | null;
  amount_cents: number;
  due_date: string;
};
type Customer = {
  id: number;
  name: string;
  billing_email: string;
  billing_address: string;
};
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error ?? "Request failed. Please retry.");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
function App() {
  const [user, setUser] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [route, setRoute] = useState(location.hash.slice(1) || "/invoices");
  const [invoices, setInvoices] = useState<Invoice[]>([]),
    [invoice, setInvoice] = useState<Invoice | null>(null),
    [customer, setCustomer] = useState<Customer | null>(null);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [billingEmail, setBillingEmail] = useState(""),
    [address, setAddress] = useState("");
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<"pay" | "void" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (confirm && dialog.current && !dialog.current.open)
      dialog.current.showModal();
  }, [confirm]);
  useEffect(() => {
    api<{ email: string }>("/session")
      .then((u) => setUser(u.email))
      .catch(() => {})
      .finally(() => setLoading(false));
    const change = () => setRoute(location.hash.slice(1) || "/invoices");
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (!user) return;
    let active = true;
    setLoading(true);
    setError("");
    setMessage("");
    setConfirm(null);
    setInvoice(null);
    setCustomer(null);
    const load = async () => {
      if (route.startsWith("/customers/")) {
        const c = await api<Customer>(route);
        if (active) {
          setCustomer(c);
          setBillingEmail(c.billing_email);
          setAddress(c.billing_address);
        }
      } else if (route.startsWith("/invoices/")) {
        const i = await api<Invoice>(route);
        if (active) setInvoice(i);
      } else {
        const list = await api<Invoice[]>("/invoices");
        if (active) setInvoices(list);
      }
    };
    load()
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user, route]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header>
        <a href="#/invoices" className="brand">
          ◈ Billing Desk
        </a>
        <span>TraceBench demo workspace</span>
        {user && (
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api("/logout", { method: "POST" });
                setUser(null);
                setPassword("");
              })
            }
          >
            Sign out
          </button>
        )}
      </header>
      <main>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="success">
            {message}
          </p>
        )}
        {loading ? (
          <p>Loading…</p>
        ) : !user ? (
          <section className="login">
            <p className="eyebrow">WELCOME BACK</p>
            <h1>Sign in to Billing Desk</h1>
            <p>Manage invoices and customer billing details.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  const u = await api<{ email: string }>("/login", {
                    method: "POST",
                    body: JSON.stringify({ email, password }),
                  });
                  setUser(u.email);
                  setPassword("");
                });
              }}
            >
              <label>
                Email
                <input
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
            <small>Demo: demo@tracebench.local / tracebench-demo</small>
          </section>
        ) : (
          <>
            <nav aria-label="Main navigation">
              <a href="#/invoices">Invoices</a>
              <span>{user}</span>
            </nav>
            {customer ? (
              <section>
                <a href="#/invoices">← All invoices</a>
                <h1>{customer.name}</h1>
                <p>Customer billing details</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      const c = await api<Customer>(
                        `/customers/${customer.id}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({
                            billing_email: billingEmail,
                            billing_address: address,
                          }),
                        },
                      );
                      setCustomer(c);
                      setBillingEmail(c.billing_email);
                      setAddress(c.billing_address);
                      setMessage("Billing details saved.");
                    });
                  }}
                >
                  <label>
                    Billing email
                    <input
                      type="email"
                      maxLength={254}
                      required
                      value={billingEmail}
                      onChange={(e) => setBillingEmail(e.target.value)}
                    />
                  </label>
                  <label>
                    Billing address
                    <textarea
                      required
                      maxLength={1000}
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                    />
                  </label>
                  <button disabled={busy}>
                    {busy ? "Saving…" : "Save billing details"}
                  </button>
                </form>
              </section>
            ) : invoice ? (
              <section>
                <a href="#/invoices">← All invoices</a>
                <h1>Invoice #{invoice.invoice_number}</h1>
                <dl>
                  <dt>Customer</dt>
                  <dd>
                    {invoice.customer_id ? (
                      <a href={`#/customers/${invoice.customer_id}`}>
                        {invoice.customer_name}
                      </a>
                    ) : (
                      "Unassigned"
                    )}
                  </dd>
                  <dt>Amount</dt>
                  <dd>{money(invoice.amount_cents)}</dd>
                  <dt>Due date</dt>
                  <dd>{invoice.due_date}</dd>
                  <dt>Status</dt>
                  <dd>
                    <span
                      data-testid="invoice-status"
                      className={`badge ${invoice.status.toLowerCase()}`}
                    >
                      {invoice.status}
                    </span>
                  </dd>
                </dl>
                {invoice.status === "PENDING" ? (
                  <div className="actions">
                    <button disabled={busy} onClick={() => setConfirm("pay")}>
                      Mark paid
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => setConfirm("void")}
                    >
                      Void invoice
                    </button>
                  </div>
                ) : (
                  <p>
                    This invoice is finalized. Its status cannot be changed.
                  </p>
                )}
                {confirm && (
                  <dialog
                    ref={dialog}
                    onCancel={(event) => {
                      event.preventDefault();
                      if (!busy) setConfirm(null);
                    }}
                    aria-labelledby="confirm-title"
                    className="confirmation"
                  >
                    <h2 id="confirm-title">
                      {confirm === "void" ? "Void" : "Mark paid"} invoice #
                      {invoice.invoice_number}?
                    </h2>
                    <p>This change is final.</p>
                    {error && <p className="error">{error}</p>}
                    <button
                      autoFocus
                      disabled={busy}
                      onClick={() => setConfirm(null)}
                    >
                      Cancel
                    </button>{" "}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const updated = await api<Invoice>(
                            `/invoices/${invoice.id}/${confirm}`,
                            { method: "POST" },
                          );
                          setInvoice({ ...invoice, status: updated.status });
                          setConfirm(null);
                          setMessage("Invoice updated.");
                        })
                      }
                    >
                      {busy ? "Updating…" : "Confirm"}
                    </button>
                  </dialog>
                )}
              </section>
            ) : !error ? (
              <section>
                <p className="eyebrow">BILLING WORKSPACE</p>
                <h1>Invoices</h1>
                <p>
                  Review balances, finalize invoices, and manage customer
                  details.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Invoice</th>
                        <th>Customer</th>
                        <th>Amount</th>
                        <th>Due date</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((i) => (
                        <tr key={i.id}>
                          <td>
                            <a href={`#/invoices/${i.id}`}>
                              Invoice #{i.invoice_number}
                            </a>
                          </td>
                          <td>
                            {i.customer_id ? (
                              <a href={`#/customers/${i.customer_id}`}>
                                {i.customer_name}
                              </a>
                            ) : (
                              "Unassigned"
                            )}
                          </td>
                          <td>{money(i.amount_cents)}</td>
                          <td>{i.due_date}</td>
                          <td>
                            <span className={`badge ${i.status.toLowerCase()}`}>
                              {i.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </>
        )}
      </main>
      <footer>
        Billing Desk · Local benchmark application · Amounts in CAD
      </footer>
    </>
  );
}
const money = (cents: number) =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(
    cents / 100,
  );
createRoot(document.getElementById("root")!).render(<App />);
