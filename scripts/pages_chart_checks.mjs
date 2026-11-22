// The same interaction assertions run against local fixtures and real Pages.
import assert from "node:assert/strict";

export async function checkChartControls(
  page,
  { firstDate, lastDate, rows, mobile = false },
) {
  let requests = 0;
  const count = (request) => {
    if (
      /^https:\/\/(push2his\.eastmoney\.com|proxy\.finance\.qq\.com|web\.ifzq\.gtimg\.cn)\//.test(
        request.url(),
      )
    )
      requests++;
  };
  page.on("request", count);
  let stage = "panel and unit labels";
  try {
    assert.equal(await page.locator(".pane-legend").count(), 5);
    const details = await page.locator("#daily-values").textContent();
    for (const unit of ["成交量（手）", "VOL5（手）", "VOL10（手）"])
      assert.ok(details.includes(unit));
    assert.match(
      await page.locator("#history-label").textContent(),
      new RegExp(rows.toLocaleString("en-US")),
    );

    stage = "all history";
    await page.locator('[data-range="all"]').click();
    await page.waitForFunction(
      ({ firstDate, lastDate }) => {
        const text = document.querySelector("#visible-range").textContent;
        return text.includes(firstDate) && text.includes(lastDate);
      },
      { firstDate, lastDate },
    );
    stage = "display interval";
    await page.locator("#display-start").fill("2021-01-01");
    await page.locator("#display-end").fill("2021-12-31");
    await page.locator("#range-form button").click();
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("显示区间已调整"),
    );
    await page.waitForFunction(() =>
      /2021-01-04.*2021-12-31/.test(
        document.querySelector("#visible-range").textContent,
      ),
    );
    const interval = await page.locator("#visible-range").textContent();
    assert.match(interval, /2021-01-04.*2021-12-31/);
    assert.match(
      await page.locator("#history-label").textContent(),
      new RegExp(rows.toLocaleString("en-US")),
    );

    stage = "crosshair";
    await page.locator('[data-range="all"]').click();
    const chart = page.locator("#chart");
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + 120 };
    if (mobile) await page.touchscreen.tap(point.x, point.y);
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '.pane-legend .legend-value[title^="原始值 "]',
        ).length === 15,
    );
    const crosshairDate = await page.locator("#selected-date").textContent();
    assert.match(crosshairDate, /^\d{4}-\d{2}-\d{2}$/);
    const beforeZoom = await page.locator("#visible-range").textContent();
    stage = "zoom";
    await page.mouse.wheel(0, -240);
    await page.waitForFunction(
      (before) =>
        document.querySelector("#visible-range").textContent !== before,
      beforeZoom,
    );
    const afterZoom = await page.locator("#visible-range").textContent();
    stage = "pan";
    await page.mouse.down();
    await page.mouse.move(point.x + 80, point.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(
      (before) =>
        document.querySelector("#visible-range").textContent !== before,
      afterZoom,
    );
    assert.equal(
      requests,
      0,
      "display dates, presets, crosshair, zoom and pan must not fetch quotes",
    );
    return {
      status: "passed",
      volume_unit: "手",
      panel_count: 5,
      history_rows: rows,
      selected_interval: interval,
      crosshair_date: crosshairDate,
      quote_requests_during_display: requests,
      zoom_changed_range: true,
      pan_changed_range: true,
    };
  } catch (error) {
    const state = await page.evaluate(() => ({
      visible: document.querySelector("#visible-range").textContent,
      start: document.querySelector("#display-start").value,
      end: document.querySelector("#display-end").value,
      status: document.querySelector("#status").textContent,
      selected: document.querySelector("#selected-date").textContent,
      validLegendValues: document.querySelectorAll(
        '.pane-legend .legend-value[title^="原始值 "]',
      ).length,
    }));
    throw new Error(`${stage}: ${error.message}; ${JSON.stringify(state)}`);
  } finally {
    page.off("request", count);
  }
}
