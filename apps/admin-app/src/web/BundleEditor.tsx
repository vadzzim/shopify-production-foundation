import { useCallback, useEffect, useState } from 'react';
import {
  ROUTINE_STEPS,
  type Bundle,
  type BundleItemInput,
  type BundleStatus,
  type CatalogCandidates,
  type RoutineStep,
} from '@nordlys/shared';

import {
  ApiRequestError,
  deleteBundle,
  updateBundle,
  type ApiRequestError as ApiError,
} from './api';

/**
 * The routine set editor.
 *
 * A modal rather than a second screen. The app is one page — there is no router
 * and no reason to add one for a form with five fields — and editing a set is
 * something a merchant does while looking at the list of sets, comparing it
 * with the others.
 *
 * Two things about the shape of this form are decisions rather than defaults:
 *
 * **Products are chosen from a list, not typed.** The value stored is a product
 * GID, and a merchant cannot be asked to know one. The list comes from the
 * catalog search, which is capped, so when the search did not reach the end of
 * the catalog the form says so instead of pretending these are all the
 * products there are.
 *
 * **The delete confirmation happens inside this modal.** Polaris modals are not
 * nested, and a second page-level modal for one confirmation would put the
 * question further from the action that raised it. So the body switches, and
 * "Delete" needs two deliberate presses.
 */

const MODAL_ID = 'bundle-editor';

interface BundleEditorProps {
  bundle: Bundle;
  /** `null` while the candidate products are still being fetched. */
  candidates: CatalogCandidates | null;
  candidatesError: ApiError | null;
  /** Called after the modal has closed, whatever closed it. */
  onClose: () => void;
  /** Called after a successful save or delete, with a message for the toast. */
  onChanged: (message: string) => void;
}

type Mode = 'edit' | 'confirm-delete';

const STATUSES: BundleStatus[] = ['draft', 'active', 'archived'];

function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The product currently in a slot, or `undefined` for an empty one. */
function itemFor(bundle: Bundle, step: RoutineStep) {
  return bundle.items.find((item) => item.routineStep === step);
}

function describeError(error: unknown): ApiError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError(
        'Something unexpected went wrong in the app.',
        0,
        error instanceof Error ? [error.message] : [],
      );
}

export function BundleEditor({
  bundle,
  candidates,
  candidatesError,
  onClose,
  onChanged,
}: BundleEditorProps): React.JSX.Element {
  const [title, setTitle] = useState(bundle.title);
  const [status, setStatus] = useState<BundleStatus>(bundle.status);
  const [selection, setSelection] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ROUTINE_STEPS.map((step) => [step, itemFor(bundle, step)?.productGid ?? '']),
    ),
  );
  const [mode, setMode] = useState<Mode>('edit');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // The element is declarative but its visibility is not: `s-modal` renders
  // hidden until something shows it, and the thing that decided to edit this
  // bundle is the React state that mounted this component.
  useEffect(() => {
    void shopify.modal.show(MODAL_ID);
  }, []);

  const close = useCallback(() => {
    void shopify.modal.hide(MODAL_ID);
  }, []);

  const onSave = useCallback(async () => {
    setPending(true);
    setError(null);

    const items: BundleItemInput[] = ROUTINE_STEPS.map((step) => ({
      productGid: selection[step] ?? '',
      routineStep: step,
    }));

    try {
      const saved = await updateBundle(bundle.id, { title, status, items });
      onChanged(`${saved.title} saved`);
      close();
    } catch (caught) {
      // The modal stays open with the values the merchant typed. Closing it on
      // a rejected activation would make them re-enter everything to read the
      // reason.
      setError(describeError(caught));
    } finally {
      setPending(false);
    }
  }, [bundle.id, close, onChanged, selection, status, title]);

  const onDelete = useCallback(async () => {
    setPending(true);
    setError(null);

    try {
      await deleteBundle(bundle.id);
      onChanged(`${bundle.title} deleted`);
      close();
    } catch (caught) {
      setError(describeError(caught));
      setMode('edit');
    } finally {
      setPending(false);
    }
  }, [bundle.id, bundle.title, close, onChanged]);

  const confirming = mode === 'confirm-delete';

  return (
    <s-modal
      id={MODAL_ID}
      heading={confirming ? 'Delete this routine set?' : `Edit ${bundle.title}`}
      onHide={onClose}
    >
      {error && (
        <s-banner heading="This did not work" tone="critical">
          <s-paragraph>{error.message}</s-paragraph>
          {error.detail.length > 0 && (
            // Verbatim: these are the slots the server refused to activate, one
            // line each, and paraphrasing them removes the only thing telling
            // the merchant which product to fix.
            <s-unordered-list>
              {error.detail.map((line) => (
                <s-list-item key={line}>{line}</s-list-item>
              ))}
            </s-unordered-list>
          )}
        </s-banner>
      )}

      {confirming ? (
        <s-stack direction="block" gap="base">
          <s-paragraph>
            “{bundle.title}” will be removed from this app. The products in it
            are not touched — they stay in your catalog.
          </s-paragraph>
          <s-paragraph tone="caution">This cannot be undone.</s-paragraph>
        </s-stack>
      ) : (
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Title"
            name="title"
            value={title}
            required
            onChange={(event) => {
              setTitle(event.currentTarget.value);
            }}
          />

          <s-select
            label="Status"
            name="status"
            value={status}
            details="Only an active set is shown on the storefront."
            onChange={(event) => {
              setStatus(event.currentTarget.value as BundleStatus);
            }}
          >
            {STATUSES.map((candidate) => (
              <s-option key={candidate} value={candidate}>
                {label(candidate)}
              </s-option>
            ))}
          </s-select>

          {candidatesError && (
            <s-banner heading="The product list could not be loaded" tone="warning">
              <s-paragraph>{candidatesError.message}</s-paragraph>
            </s-banner>
          )}

          {ROUTINE_STEPS.map((step) => (
            <StepSelect
              key={step}
              step={step}
              bundle={bundle}
              candidates={candidates}
              value={selection[step] ?? ''}
              onSelect={(productGid) => {
                setSelection((current) => ({ ...current, [step]: productGid }));
              }}
            />
          ))}

          {candidates && !candidates.exhausted && (
            <s-paragraph color="subdued">
              These are the first {candidates.scanned} active products in the
              catalog. Run the catalog export to see how every product is
              assigned.
            </s-paragraph>
          )}
        </s-stack>
      )}

      {confirming ? (
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={pending}
          onClick={() => void onDelete()}
        >
          Delete routine set
        </s-button>
      ) : (
        <s-button
          slot="primary-action"
          variant="primary"
          loading={pending}
          onClick={() => void onSave()}
        >
          Save
        </s-button>
      )}

      {confirming ? (
        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setMode('edit');
          }}
        >
          Keep it
        </s-button>
      ) : (
        <s-button
          slot="secondary-actions"
          variant="secondary"
          tone="critical"
          disabled={pending}
          onClick={() => {
            setMode('confirm-delete');
          }}
        >
          Delete
        </s-button>
      )}

      <s-button
        slot="secondary-actions"
        variant="secondary"
        disabled={pending}
        onClick={close}
      >
        Cancel
      </s-button>
    </s-modal>
  );
}

/**
 * One step's product picker.
 *
 * The product currently in the slot is always an option, even when the catalog
 * search did not return it — it may sit beyond the search's page cap, or have
 * been deleted in Shopify since it was added. Dropping it would silently change
 * the slot the moment the merchant pressed Save on an unrelated field.
 */
function StepSelect({
  step,
  bundle,
  candidates,
  value,
  onSelect,
}: {
  step: RoutineStep;
  bundle: Bundle;
  candidates: CatalogCandidates | null;
  value: string;
  onSelect: (productGid: string) => void;
}): React.JSX.Element {
  const current = itemFor(bundle, step);
  const offered = (candidates?.candidates ?? []).filter(
    (candidate) => candidate.routineStep === step,
  );

  const options = offered.map((candidate) => ({
    value: candidate.productGid,
    text: candidate.title,
  }));

  if (current && !offered.some((entry) => entry.productGid === value)) {
    options.unshift({
      value: current.productGid,
      text: current.title ?? 'Product no longer in the catalog',
    });
  }

  return (
    <s-select
      label={label(step)}
      name={step}
      value={value}
      placeholder={candidates === null ? 'Loading products…' : 'Choose a product'}
      disabled={candidates === null}
      onChange={(event) => {
        onSelect(event.currentTarget.value ?? '');
      }}
    >
      {options.map((option) => (
        <s-option key={option.value} value={option.value}>
          {option.text}
        </s-option>
      ))}
    </s-select>
  );
}
