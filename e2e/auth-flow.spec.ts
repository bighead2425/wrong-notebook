import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {

    test('Registration and fallback Login', async ({ page }) => {
        // 增加测试超时时间
        test.setTimeout(60000);

        const user = {
            name: 'jason',
            email: 'jason@qq.com',
            password: '123456',
            stage: 'junior_high',
            year: '2024' // 使用当前年份确保有效
        };

        // --- Try Registration ---
        await page.goto('/register');

        // Wait for page to be ready (bypassing loading state)
        // "注册" or "Create an Account"
        await expect(page.locator('body')).toContainText(/注册|Register/, { timeout: 15000 });

        // Selectors by NAME (Robust now)
        await page.locator('input[name="name"]').fill(user.name);
        await page.locator('input[name="email"]').fill(user.email);
        await page.locator('input[name="password"]').fill(user.password);
        await page.locator('input[name="confirmPassword"]').fill(user.password);

        // Education Stage
        await page.locator('select[name="educationStage"]').selectOption(user.stage);

        // Enrollment Year
        await page.locator('input[name="enrollmentYear"]').fill(user.year);

        // Submit
        await page.locator('button[type="submit"]').click();

        // --- Handle Result ---
        try {
            // Error: "该邮箱已被注册"
            const errorLocator = page.locator('.text-red-500');

            // Race: Error text OR redirect to login
            await Promise.race([
                expect(errorLocator).toBeVisible({ timeout: 5000 }),
                page.waitForURL('**/login', { timeout: 5000 })
            ]);

            if (await errorLocator.isVisible()) {
                console.log('Registration error visible, going to login.');
                await page.goto('/login');
            }
        } catch (e) {
            if (page.url().includes('/login')) {
                console.log('Redirected to login page automatically.');
            } else {
                console.log('State unclear, forcing login.');
                await page.goto('/login');
            }
        }

        // --- Login Flow ---
        // Ensure we are on login page
        await page.waitForURL('**/login');

        await page.locator('input[name="email"]').fill(user.email);
        await page.locator('input[name="password"]').fill(user.password);

        await page.locator('button[type="submit"]').click();

        // --- Verify Success ---
        // Wait for redirect to home
        await page.waitForURL('/', { timeout: 10000 });

        // Verify Content
        await expect(page.locator('body')).toContainText(user.name);

        // --- Logout User ---
        /**
         * 【2026-10-20】主页那颗「退出」按钮**撤掉了**（空空的要求：
         * "退出放入设置的『关于』中"）⇒ 这条路径改成 设置 → 关于 → 退出。
         * 入口是左上角那颗带用户名的按钮（title 里有"进设置"）。
         */
        await page.getByTitle(/进设置|logout is inside/).click();
        await page.getByRole('tab', { name: /About|关于/ }).click();
        await page.getByRole('button', { name: /退出登录|Sign out/ }).click();
        await page.waitForURL('**/login');

        // --- Login as Admin ---
        await page.locator('input[name="email"]').fill('admin@localhost');
        await page.locator('input[name="password"]').fill('123456');
        await page.locator('button[type="submit"]').click();

        // Verify Admin Login and Home Page
        await page.waitForURL('**/');

        // --- Go to Settings > User Management ---
        // 【2026-10-20】主页的齿轮按钮撤掉了 ⇒ 入口改成左上角用户名（title 含"进设置"）
        await page.getByTitle(/进设置|logout is inside/).click();

        // Wait for Dialog
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

        // Click "User Management" / "用户管理" Tab
        await page.getByRole('tab', { name: /User Management|用户管理/ }).click();

        // 等待用户列表加载
        await page.waitForTimeout(1000);

        // --- Delete User 'jason' ---
        // Find row with 'jason@qq.com'
        const userRow = page.locator('tr').filter({ hasText: user.email });

        // 使用更长的超时时间等待用户行出现
        await expect(userRow).toBeVisible({ timeout: 10000 });

        // Setup dialog handler for delete confirmation
        page.once('dialog', async dialog => {
            console.log(`Delete User Dialog: ${dialog.message()}`);
            await dialog.accept();
        });

        // Click Delete button in that row (Trash icon)
        // The button has title "Delete" or "删除"
        await userRow.getByRole('button', { name: /Delete|删除/ }).click();

        // Verify user is gone
        await expect(page.locator('tr').filter({ hasText: user.email })).not.toBeVisible({ timeout: 5000 });

        // --- Logout Admin ---
        // Close dialog first
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).not.toBeVisible();

        // Click Logout
        // 【2026-10-20】同上：退出在「设置 → 关于」里
        await page.getByTitle(/进设置|logout is inside/).click();
        await page.getByRole('tab', { name: /About|关于/ }).click();
        await page.getByRole('button', { name: /退出登录|Sign out/ }).click();
        await page.waitForURL('**/login');

    });
});
