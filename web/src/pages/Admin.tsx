import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import {
  adjustCredits,
  deleteUser,
  listUsers,
  type AdminUser,
} from "../api/admin";
import { useAuth } from "../context/AuthContext";

const PAGE_SIZE = 20;

type CreditDialogState = { user: AdminUser } | null;
type DeleteDialogState = { user: AdminUser } | null;

export default function Admin() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [creditDialog, setCreditDialog] = useState<CreditDialogState>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState>(null);

  const load = useCallback(async (nextOffset: number) => {
    setLoading(true);
    setListError(null);
    try {
      const page = await listUsers(PAGE_SIZE, nextOffset);
      setUsers(page.users);
      setOffset(page.offset);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  const hasNextPage = users.length === PAGE_SIZE;
  const hasPrevPage = offset > 0;

  return (
    <div className="page">
      <h1 className="page__title">Admin</h1>

      {listError && (
        <p className="field-error" role="alert">
          {listError}
        </p>
      )}

      <div className="table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Credits</th>
              <th>Created</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {users.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.username}
                  {row.is_admin && <span className="admin-badge">admin</span>}
                </td>
                <td className={row.credits < 0 ? "app-header__credits--negative" : ""}>
                  {row.credits.toLocaleString()}
                </td>
                <td>{new Date(row.created_at).toLocaleDateString()}</td>
                <td className="admin-table__actions">
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => setCreditDialog({ user: row })}
                  >
                    Adjust credits
                  </button>
                  <button
                    type="button"
                    className="button button--small button--danger"
                    disabled={row.id === currentUser?.id}
                    title={
                      row.id === currentUser?.id
                        ? "you cannot delete your own account"
                        : undefined
                    }
                    onClick={() => setDeleteDialog({ user: row })}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={4} className="admin-table__empty">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <button
          type="button"
          className="button"
          disabled={!hasPrevPage || loading}
          onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
        >
          Previous
        </button>
        <button
          type="button"
          className="button"
          disabled={!hasNextPage || loading}
          onClick={() => void load(offset + PAGE_SIZE)}
        >
          Next
        </button>
      </div>

      {creditDialog && (
        <CreditDialog
          user={creditDialog.user}
          onClose={() => setCreditDialog(null)}
          onDone={() => {
            setCreditDialog(null);
            void load(offset);
          }}
        />
      )}

      {deleteDialog && (
        <DeleteDialog
          user={deleteDialog.user}
          onClose={() => setDeleteDialog(null)}
          onDone={() => {
            setDeleteDialog(null);
            void load(offset);
          }}
        />
      )}
    </div>
  );
}

function CreditDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const parsed = Number(amount);
    if (!Number.isInteger(parsed) || parsed === 0) {
      setError("amount must be a non-zero whole number");
      return;
    }
    if (reason.trim().length === 0) {
      setError("reason is required");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await adjustCredits(user.id, parsed, reason.trim());
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to adjust credits");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="credit-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="credit-dialog-title" className="modal__title">
          Adjust credits &mdash; {user.username}
        </h2>
        <p className="modal__hint">Current balance: {user.credits.toLocaleString()}</p>

        <label className="field">
          <span className="field__label">Amount (signed)</span>
          <input
            className="field__input"
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 500 or -200"
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field__label">Reason</span>
          <input
            className="field__input"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleDelete = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await deleteUser(user.id);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to delete user");
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="delete-dialog-title" className="modal__title">
          Delete {user.username}?
        </h2>
        <p className="modal__hint">This permanently removes the account and its sessions.</p>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => void handleDelete()}
            disabled={submitting}
          >
            {submitting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
