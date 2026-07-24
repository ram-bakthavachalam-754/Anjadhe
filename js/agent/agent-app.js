/**
 * Agent App - Registers AI Assistant as a full app with chat history
 */

const AgentApp = {
    init() {
        // init() fires when the app is opened (vs. render() on re-renders), so
        // this is where we decide entry behavior like starting a fresh chat.
        AgentUI.renderAppView({ entering: true });
    },

    render() {
        AgentUI.renderAppView();
    }
};

AppManager.register('agent', AgentApp);
