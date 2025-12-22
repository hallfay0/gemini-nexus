
// background/control/actions/base.js
import { WaitForHelper } from '../wait_helper.js';

export class BaseActionHandler {
    constructor(connection, snapshotManager, waitHelper) {
        this.connection = connection;
        this.snapshotManager = snapshotManager;
        // Use injected waitHelper or create new one (fallback)
        this.waitHelper = waitHelper || new WaitForHelper(connection);
    }

    // Helper: Send command via connection
    cmd(method, params) {
        return this.connection.sendCommand(method, params);
    }

    /**
     * @deprecated Use this.waitHelper.waitForStableDOM() directly
     */
    async waitForStableDOM(timeout = 3000, stabilityDuration = 500) {
        return this.waitHelper.waitForStableDOM(timeout, stabilityDuration);
    }

    async getObjectIdFromUid(uid) {
        const backendNodeId = this.snapshotManager.getBackendNodeId(uid);
        if (!backendNodeId) throw new Error(`Node with uid ${uid} not found in snapshot. Take a snapshot first.`);

        const { object } = await this.cmd("DOM.resolveNode", { backendNodeId });
        return object.objectId;
    }
}
