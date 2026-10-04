use iroh_gossip::proto::{Command, InEvent, Message, OutEvent, PeerData, State, TopicId};
use n0_future::time::Instant;
use rand::SeedableRng;

#[test]
fn repeated_join_replies_after_an_unanswered_neighbor_request() {
    let topic: TopicId = [1u8; 32].into();
    let mut state = State::new(1u64, PeerData::new(Vec::new()), Default::default(), rand::rngs::SmallRng::seed_from_u64(1));
    let now = Instant::now();
    state.handle(InEvent::Command(topic, Command::Join(vec![])), now, None).for_each(drop);
    let join: Message<u64> = serde_json::from_value(serde_json::json!({
        "topic": ([1u8; 32].to_vec()), "message": { "Swarm": { "Join": null } }
    })).unwrap();
    for attempt in 0..3 {
        let responses: Vec<_> = state.handle(InEvent::RecvMessage(2, join.clone()), now, None).collect();
        assert!(responses.iter().any(|event| {
            match event {
                OutEvent::SendMessage(2, message) => serde_json::to_value(message).unwrap()["message"]["Swarm"].get("Neighbor").is_some(),
                _ => false,
            }
        }), "Join attempt {attempt} must receive a fresh Neighbor response");
    }
}
