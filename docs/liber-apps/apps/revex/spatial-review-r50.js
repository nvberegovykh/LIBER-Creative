(() => {
  'use strict';
  if (window.__revexSpatialReviewR50) return;
  window.__revexSpatialReviewR50 = true;

  function install() {
    const viewer = window.__revexViewerR26Instance;
    const spatial = Array.isArray(viewer?.data?.spatialElements) ? viewer.data.spatialElements : [];
    if (!viewer || !spatial.length) return false;

    // The physical element stream intentionally excludes SpatialElement. Add a review-only
    // metadata projection after exact geometry has loaded so it cannot create proxy boxes or
    // affect mesh coverage. The Areas control can then use the authoritative bounds/loops.
    const elements = Array.isArray(viewer.data.elements) ? viewer.data.elements : [];
    viewer.data.elements = elements.filter((row) => !row?.__revexSpatialReview).concat(spatial.map((row) => ({
      ...row,
      __revexSpatialReview: true,
      proxyEligible: false,
      geometryRole: 'spatial-review'
    })));

    const button = document.getElementById('areas-toggle');
    if (button) {
      button.hidden = false;
      button.title = `Show ${spatial.length} current Revit Room / Space / Area positions`;
    }

    const search = document.getElementById('element-search');
    if (search) search.dispatchEvent(new Event('input', { bubbles: true }));
    window.__revexBrowserDiagnostics?.emit?.('INFO', 'SPATIAL_REVIEW', `Current Revit spatial positions available: ${spatial.length}.`, {
      initiator: 'r49 spatial review projection'
    });
    return true;
  }

  window.addEventListener('revex:source-revision-loaded', () => setTimeout(install, 80));
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (install() || attempts > 120) clearInterval(timer);
  }, 100);
})();
