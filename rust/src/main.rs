use serde::Deserialize;
use reqwest::Error;

// 1. Define a struct that matches the API response layout
#[derive(Deserialize, Debug)]
struct Post {
    userId: u32,
    id: u32,
    title: String,
    body: String,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let url = "https://typicode.com";

    // 2. Initialize the HTTP client and send a GET request
    let client = reqwest::Client::new();
    let response = client.get(url).send().await?;

    // 3. Parse the JSON body into our Post struct
    let post: Post = response.json().await?;

    // 4. Print out the formatted data
    println!("Successfully fetched Post #{}: \n{:#?}", post.id, post);

    Ok(())
}
