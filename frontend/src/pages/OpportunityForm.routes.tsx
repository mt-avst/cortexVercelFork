import React from 'react';
import { Route } from 'react-router-dom';

/**
 * The authoring form's routes, in ONE place that both App.tsx and the tests
 * read.
 *
 * They were declared in App.tsx and restated in the preview test, which is a
 * shape no test can police: delete either nested `preview` child and the whole
 * suite still passes, while in the product `/admin/opportunities/new/preview`
 * falls through to App's catch-all, redirects to `/`, and unmounts the form -
 * destroying the unsaved draft the nesting exists to protect. A reproduction
 * cannot detect drift from the thing it reproduces.
 *
 * The element is a PARAMETER rather than an import, for two reasons that point
 * the same way: App.tsx loads OpportunityForm lazily and must keep doing so,
 * and what needs guarding here is the paths and the nesting, not which
 * component is mounted at them.
 *
 * `element={null}` on the children because there is nothing to render there:
 * the parent draws the preview, since only the parent holds the draft. The
 * child exists to be MATCHED - that is what keeps the form mounted while the
 * URL says `/preview`, and what stops the catch-all claiming it.
 */
export const opportunityFormRoutes = (element: React.ReactNode) => (
  <>
    <Route path="/admin/opportunities/new" element={element}>
      <Route path="preview" element={null} />
    </Route>
    <Route path="/admin/opportunities/:id/edit" element={element}>
      <Route path="preview" element={null} />
    </Route>
  </>
);
